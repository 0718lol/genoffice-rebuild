import http from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSettings, propose as proposeWithProvider, providerStatus, streamPropose } from "./ai-provider.js";

const root = dirname(fileURLToPath(import.meta.url));
const dataFile = join(root, "data", "projects.json");
const aiSettingsFile = join(root, "data", "ai-settings.json");
const publicDir = join(root, "public");
const execFileAsync = promisify(execFile);
const assetsDir = join(root, "data", "assets");

function isLegacyTestProject(project) {
  if (project?.title === "Conflict test" && ["# One", "# Two"].includes(project.content)) return true;
  return project?.title === "HTTP export" && project.content === "# Hello\n\n- One\n- Two\n\n![Diagram](diagram.png)";
}

async function readProjects() {
  try { return JSON.parse(await readFile(dataFile, "utf8")).filter((project) => !isLegacyTestProject(project)); }
  catch { return []; }
}

async function saveProjects(projects) {
  await mkdir(dirname(dataFile), { recursive: true });
  await writeFile(dataFile, JSON.stringify(projects, null, 2));
}

async function readAiSettings() {
  try { return normalizeSettings(JSON.parse(await readFile(aiSettingsFile, "utf8"))); }
  catch { return {}; }
}

async function saveAiSettings(settings) {
  await mkdir(dirname(aiSettingsFile), { recursive: true });
  await writeFile(aiSettingsFile, JSON.stringify(settings, null, 2));
}

function projectRevision(project) {
  return Number.isInteger(project.revision) ? project.revision : (project.revisions || []).length;
}

function send(res, status, body, type = "application/json", headers = {}) {
  const contentType = type.startsWith("text/") || type === "application/json" ? `${type}; charset=utf-8` : type;
  res.writeHead(status, { "content-type": contentType, ...headers });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function downloadName(title) {
  return `${String(title || "document").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "document"}.docx`;
}

function streamEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/projects" && req.method === "GET") {
      return send(res, 200, await readProjects());
    }
    if (url.pathname === "/api/projects" && req.method === "POST") {
      const input = await body(req);
      const projects = await readProjects();
      const now = new Date().toISOString();
      const project = { id: crypto.randomUUID(), title: input.title?.trim() || "未命名文档", content: input.content ?? "", updatedAt: now, revision: 0, revisions: [] };
      projects.unshift(project);
      await saveProjects(projects);
      return send(res, 201, project);
    }
    if (url.pathname === "/api/import" && req.method === "POST") {
      const input = await body(req);
      const projectId = crypto.randomUUID();
      let importedAssets = [];
      if (/\.docx$/i.test(input.fileName || "")) {
        if (!input.base64 || input.base64.length > 28_000_000) return send(res, 400, { error: "DOCX file is missing or larger than 20 MB" });
        const temporary = join(root, `.${crypto.randomUUID()}.docx`);
        try {
          await writeFile(temporary, Buffer.from(input.base64, "base64"));
          const projectAssets = join(assetsDir, projectId);
          const result = await execFileAsync("python3", [join(root, "docx_to_markdown.py"), temporary, projectAssets, `/api/projects/${projectId}/assets/`], { maxBuffer: 4 * 1024 * 1024 });
          const converted = JSON.parse(result.stdout);
          input.content = converted.markdown;
          importedAssets = converted.assets;
          input.docxMeta = converted.metadata || { headers: [], footers: [] };
        } catch (error) {
          return send(res, 400, { error: `DOCX import failed: ${error.stderr || error.message}` });
        } finally { await rm(temporary, { force: true }); }
      }
      const projects = await readProjects();
      const now = new Date().toISOString();
      const project = { id: projectId, title: input.title?.trim() || "导入的文档", content: input.content || "", importedFrom: input.fileName || null, assets: importedAssets, docxMeta: input.docxMeta || null, updatedAt: now, revision: 0, revisions: [] };
      projects.unshift(project);
      await saveProjects(projects);
      return send(res, 201, project);
    }
    if (url.pathname === "/api/ai/status" && req.method === "GET") {
      return send(res, 200, providerStatus(await readAiSettings()));
    }
    if (url.pathname === "/api/ai/settings" && req.method === "GET") {
      const settings = await readAiSettings();
      return send(res, 200, { ...settings, ...providerStatus(settings) });
    }
    if (url.pathname === "/api/ai/settings" && req.method === "PUT") {
      try {
        const settings = normalizeSettings(await body(req));
        await saveAiSettings(settings);
        return send(res, 200, { ...settings, ...providerStatus(settings) });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    if (url.pathname === "/api/ai/propose/stream" && req.method === "POST") {
      const input = await body(req);
      const controller = new AbortController();
      const cancelOnDisconnect = () => {
        if (!req.complete) controller.abort();
      };
      const cancelOnResponseClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.on("aborted", cancelOnDisconnect);
      req.on("close", cancelOnDisconnect);
      res.on("close", cancelOnResponseClose);
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      try {
        for await (const event of streamPropose(input, await readAiSettings(), controller.signal)) {
          if (res.writableEnded) break;
          streamEvent(res, event);
        }
      } catch (error) {
        if (!res.writableEnded && !controller.signal.aborted) streamEvent(res, { type: "error", error: error.message });
      } finally {
        req.off("aborted", cancelOnDisconnect);
        req.off("close", cancelOnDisconnect);
        res.off("close", cancelOnResponseClose);
        if (!res.writableEnded) res.end();
      }
      return;
    }
    if (url.pathname === "/api/ai/propose" && req.method === "POST") {
      const input = await body(req);
      try {
        return send(res, 200, await proposeWithProvider(input, await readAiSettings()));
      } catch (error) {
        return send(res, 502, { error: error.message });
      }
    }
    const assetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets\/([^/]+)$/);
    if (assetMatch && req.method === "GET") {
      const file = assetMatch[2].replace(/[^a-zA-Z0-9._-]/g, "_");
      try { return send(res, 200, await readFile(join(assetsDir, assetMatch[1], file)), file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") || file.endsWith(".jpeg") ? "image/jpeg" : "application/octet-stream"); }
      catch { return send(res, 404, { error: "Asset not found" }); }
    }
    const match = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/([^/]+))?$/);
    if (match) {
      const [, id, action] = match;
      const projects = await readProjects();
      const project = projects.find((item) => item.id === id);
      if (!project) return send(res, 404, { error: "Project not found" });
      if (req.method === "GET" && !action) return send(res, 200, project);
      if (req.method === "POST" && action === "save") {
        const input = await body(req);
        const currentRevision = projectRevision(project);
        if (input.baseRevision !== undefined && Number(input.baseRevision) !== currentRevision) {
          return send(res, 409, { error: "Document changed since this operation was prepared", project });
        }
        const nextTitle = input.title?.trim() || project.title;
        const nextContent = input.content ?? project.content;
        if (nextTitle === project.title && nextContent === project.content) return send(res, 200, project);
        project.revisions.unshift({ content: project.content, savedAt: project.updatedAt });
        project.revisions = project.revisions.slice(0, 20);
        project.title = nextTitle;
        project.content = nextContent;
        project.revision = currentRevision + 1;
        project.updatedAt = new Date().toISOString();
        await saveProjects(projects);
        return send(res, 200, project);
      }
      if (req.method === "POST" && action === "restore") {
        const input = await body(req);
        const revision = project.revisions[Number(input.index)];
        if (!revision) return send(res, 400, { error: "Revision not found" });
        project.revisions.unshift({ content: project.content, savedAt: project.updatedAt });
        project.content = revision.content;
        project.revision = projectRevision(project) + 1;
        project.updatedAt = new Date().toISOString();
        await saveProjects(projects);
        return send(res, 200, project);
      }
    }
    const exportMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/export\/docx$/);
    if (exportMatch && req.method === "POST") {
      const projects = await readProjects();
      const project = projects.find((item) => item.id === exportMatch[1]);
      if (!project) return send(res, 404, { error: "Project not found" });
      const temporaryMarkdown = join(root, `.${crypto.randomUUID()}.md`);
      const temporaryDocx = join(root, `.${crypto.randomUUID()}.docx`);
      try {
        await writeFile(temporaryMarkdown, project.content || "", "utf8");
        await execFileAsync("python3", [join(root, "markdown_to_docx.py"), temporaryMarkdown, join(assetsDir, project.id), temporaryDocx, JSON.stringify(project.docxMeta || {})], { maxBuffer: 4 * 1024 * 1024 });
        return send(
          res,
          200,
          await readFile(temporaryDocx),
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          { "content-disposition": `attachment; filename="${downloadName(project.title)}"` }
        );
      } catch (error) {
        return send(res, 400, { error: `DOCX export failed: ${error.stderr || error.message}` });
      } finally {
        await rm(temporaryMarkdown, { force: true });
        await rm(temporaryDocx, { force: true });
      }
    }
    if (req.method === "GET") {
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
      try { return send(res, 200, await readFile(join(publicDir, file)), type); }
      catch { return send(res, 404, "Not found", "text/plain"); }
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
});

server.listen(Number(process.env.PORT) || 3000, "0.0.0.0");
