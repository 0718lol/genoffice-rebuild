const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_CONTENT_LENGTH = 120_000;

function trimBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

function localPreview(content, task) {
  const normalizedTask = task.toLowerCase();
  if (normalizedTask.includes("summar")) {
    return "## Summary\n\n- This document is ready for review.\n- The main ideas have been condensed into a short overview.\n- Add source details before publishing.";
  }
  if (normalizedTask.includes("continu")) {
    return `${content.trim()}\n\n## Next steps\n\nDefine the next action, owner, and expected outcome.`;
  }
  return content.replace(/^# (.+)$/m, "# $1\n\n> Draft improved for clarity and structure.\n");
}

export function normalizeSettings(input = {}) {
  const provider = input.provider === "openai-compatible" ? "openai-compatible" : "local";
  const baseUrl = trimBaseUrl(input.baseUrl || process.env.GENOFFICE_AI_BASE_URL || DEFAULT_BASE_URL);
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("AI base URL must start with http:// or https://");
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error("AI base URL must not contain credentials, query parameters, or fragments");
  const model = String(input.model || process.env.GENOFFICE_AI_MODEL || DEFAULT_MODEL).trim().slice(0, 120) || DEFAULT_MODEL;
  return { provider, baseUrl, model };
}

export function getProviderConfig(settings = {}) {
  const envProvider = process.env.GENOFFICE_AI_PROVIDER === "openai-compatible" ? "openai-compatible" : "local";
  const normalized = normalizeSettings({
    provider: settings.provider || envProvider,
    baseUrl: settings.baseUrl || process.env.GENOFFICE_AI_BASE_URL,
    model: settings.model || process.env.GENOFFICE_AI_MODEL,
  });
  return { ...normalized, apiKey: process.env.GENOFFICE_AI_API_KEY || "" };
}

export function providerStatus(settings = {}) {
  const config = getProviderConfig(settings);
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    configured: config.provider === "local" || Boolean(config.apiKey),
    apiKeyConfigured: Boolean(config.apiKey),
  };
}

function stripCodeFence(value) {
  const text = String(value || "").trim();
  const match = text.match(/^```(?:json|markdown)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text;
}

function parseModelOutput(value) {
  const text = stripCodeFence(value);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed.trim();
    return String(parsed.preview || parsed.content || parsed.markdown || "").trim();
  } catch {
    return text;
  }
}

function endpointFor(baseUrl) {
  return /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
}

async function remotePreview(content, task, config) {
  if (!config.apiKey) throw new Error("OpenAI-compatible provider is selected, but GENOFFICE_AI_API_KEY is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(endpointFor(config.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "You are a careful document editor. Return only the proposed Markdown document, without explanations or code fences. Preserve useful content unless the request requires a change." },
          { role: "user", content: `Task: ${task}\n\nCurrent Markdown document:\n\n${content}` },
        ],
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
    if (!response.ok) {
      const detail = payload.error?.message || payload.error || `Provider returned HTTP ${response.status}`;
      throw new Error(`AI provider error: ${String(detail).slice(0, 300)}`);
    }
    const output = payload.choices?.[0]?.message?.content;
    if (!output) throw new Error("AI provider returned an empty response");
    return parseModelOutput(output);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("AI provider timed out after 45 seconds");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function propose(input, settings = {}) {
  const content = String(input.content || "").slice(0, MAX_CONTENT_LENGTH);
  const task = String(input.task || "Improve this document").trim().slice(0, 500) || "Improve this document";
  const config = getProviderConfig(settings);
  const preview = config.provider === "local" ? localPreview(content, task) : await remotePreview(content, task, config);
  if (!preview) throw new Error("AI proposal is empty");
  return {
    provider: config.provider,
    model: config.model,
    operation: {
      id: crypto.randomUUID(),
      label: task,
      baseRevision: Number.isInteger(input.revision) ? input.revision : Number(input.revision) || 0,
      changes: [{ type: "replace_document", content: preview }],
    },
    preview,
  };
}
