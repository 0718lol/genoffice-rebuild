import http from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dataFile = join(root, "data", "projects.json");
const publicDir = join(root, "public");
const execFileAsync = promisify(execFile);
const assetsDir = join(root, "data", "assets");

async function readProjects() {
  try { return JSON.parse(await readFile(dataFile, "utf8")); }
  catch { return []; }
}

async function saveProjects(projects) {
  await mkdir(dirname(dataFile), { recursive: true });
  await writeFile(dataFile, JSON.stringify(projects, null, 2));
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
      const project = { id: crypto.randomUUID(), title: input.title?.trim() || "Untitled document", content: input.content || "# Untitled document\n\nStart writing here.", updatedAt: now, revisions: [] };
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
      const project = { id: projectId, title: input.title?.trim() || "Imported document", content: input.content || "", importedFrom: input.fileName || null, assets: importedAssets, docxMeta: input.docxMeta || null, updatedAt: now, revisions: [] };
      projects.unshift(project);
      await saveProjects(projects);
      return send(res, 201, project);
    }
    if (url.pathname === "/api/ai/propose" && req.method === "POST") {
      const input = await body(req);
      const content = String(input.content || "");
      const task = String(input.task || "Improve this document");
      const preview = task.toLowerCase().includes("summar")
        ? "## Summary\n\n- This document is ready for review.\n- The main ideas have been condensed into a short overview.\n- Add source details before publishing."
        : task.toLowerCase().includes("continu")
          ? `${content.trim()}\n\n## Next steps\n\nDefine the next action, owner, and expected outcome.`
          : content.replace(/^# (.+)$/m, "# $1\n\n> Draft improved for clarity and structure.\n");
      return send(res, 200, { provider: "local-provider", operation: { id: crypto.randomUUID(), label: task, baseRevision: input.revision, changes: [{ type: "replace_document", content: preview }] }, preview });
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
        const nextTitle = input.title?.trim() || project.title;
        const nextContent = input.content ?? project.content;
        if (nextTitle === project.title && nextContent === project.content) return send(res, 200, project);
        project.revisions.unshift({ content: project.content, savedAt: project.updatedAt });
        project.revisions = project.revisions.slice(0, 20);
        project.title = nextTitle;
        project.content = nextContent;
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
