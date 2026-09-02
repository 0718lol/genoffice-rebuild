const state = { projects: [], current: null, saveTimer: null, savePromise: null, busy: false, undoStack: [], redoStack: [], lastEditorValue: "" };
const $ = (id) => document.getElementById(id);
const formatDate = (value) => value ? new Date(value).toLocaleString("zh-CN", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }) : "";
function setStatus(text, tone = "") { const node = $("saveState"); node.textContent = text; node.className = `status-chip${tone ? ` ${tone}` : ""}`; }
function setBusy(button, busy, label) { if (!button) return; button.disabled = busy; if (busy) { button.dataset.label = button.textContent; button.textContent = label; } else if (button.dataset.label) { button.textContent = button.dataset.label; delete button.dataset.label; } }
async function api(path, options) { const response = await fetch(path, { headers: { "content-type":"application/json" }, ...options }); if (!response.ok) { const raw = await response.text(); let detail = "Request failed"; let payload = {}; try { payload = JSON.parse(raw); detail = payload.error || detail; } catch {} const error = new Error(detail); error.status = response.status; error.payload = payload; throw error; } return response.json(); }
function renderProjects() { $("projectList").innerHTML = state.projects.map((p) => `<button class="project ${p.id === state.current?.id ? "active" : ""}" data-id="${p.id}">${escapeHtml(p.title)}</button>`).join(""); document.querySelectorAll(".project").forEach((button) => button.onclick = () => openProject(button.dataset.id)); }
function renderEditor() { if (!state.current) return; $("title").value = state.current.title; $("editor").value = state.current.content; state.lastEditorValue = state.current.content; state.undoStack = []; state.redoStack = []; updateUndoButtons(); $("updatedAt").textContent = `Last saved ${formatDate(state.current.updatedAt)}`; updateCount(); updateSelectionState(); renderHistory(); renderProjects(); }
function renderHistory() { $("historyList").innerHTML = (state.current.revisions || []).slice(0, 8).map((r, i) => `<div class="revision"><span>${formatDate(r.savedAt)}</span><button data-index="${i}">Restore</button></div>`).join("") || `<div class="revision"><span>No earlier revisions</span></div>`; document.querySelectorAll(".revision button").forEach((b) => b.onclick = () => restore(Number(b.dataset.index))); }
function updateCount() { $("wordCount").textContent = `${$("editor").value.trim().split(/\s+/).filter(Boolean).length} words`; }
function updateSelectionState() { const editor = $("editor"); const start = editor.selectionStart ?? 0; const end = editor.selectionEnd ?? 0; $("selectionState").textContent = end > start ? `Selection ${end - start} chars` : "No selection"; }
function updateUndoButtons() { $("undoEdit").disabled = !state.undoStack.length || state.busy; $("redoEdit").disabled = !state.redoStack.length || state.busy; }
function recordEditorChange(nextValue) { if (nextValue === state.lastEditorValue) return; state.undoStack.push(state.lastEditorValue); state.undoStack = state.undoStack.slice(-50); state.redoStack = []; state.lastEditorValue = nextValue; updateUndoButtons(); }
function queueSave() { clearTimeout(state.saveTimer); state.saveTimer = setTimeout(save, 700); }
function undoEdit() { if (!state.undoStack.length || state.busy) return; state.redoStack.push($("editor").value); $("editor").value = state.undoStack.pop(); state.lastEditorValue = $("editor").value; updateCount(); updateUndoButtons(); queueSave(); setStatus("Undo"); }
function redoEdit() { if (!state.redoStack.length || state.busy) return; state.undoStack.push($("editor").value); $("editor").value = state.redoStack.pop(); state.lastEditorValue = $("editor").value; updateCount(); updateUndoButtons(); queueSave(); setStatus("Redo"); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[char])); }
function diffLines(before, after) {
  const left = String(before).split("\n"); const right = String(after).split("\n");
  const table = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const rows = []; let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) rows.push(["same", left[i++]]);
    else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) rows.push(["added", right[j++]]);
    else rows.push(["removed", left[i++]]);
  }
  return rows.map(([type, line]) => `<div class="diff-row ${type}"><span>${type === "added" ? "+" : type === "removed" ? "-" : " "}</span><code>${escapeHtml(line) || " "}</code></div>`).join("");
}
async function openProject(id) { state.current = await api(`/api/projects/${id}`); state.current.revision ??= (state.current.revisions || []).length; renderEditor(); }
async function save(baseRevision = state.current?.revision ?? 0) { if (!state.current) return; if (state.savePromise) return state.savePromise; const projectId = state.current.id; const payload = { title:$("title").value, content:$("editor").value, baseRevision }; setStatus("Saving..."); state.savePromise = api(`/api/projects/${projectId}/save`, { method:"POST", body:JSON.stringify(payload) }).then((project) => { if (state.current?.id === project.id) state.current = project; setStatus("Saved locally"); renderHistory(); renderProjects(); $("updatedAt").textContent = `Last saved ${formatDate(project.updatedAt)}`; return project; }).catch((error) => { setStatus(error.status === 409 ? "Document changed; reload before applying" : error.message, "error"); throw error; }).finally(() => { state.savePromise = null; }); return state.savePromise; }
async function restore(index) { if (!state.current) return; setStatus("Restoring..."); try { state.current = await api(`/api/projects/${state.current.id}/restore`, { method:"POST", body:JSON.stringify({ index }) }); renderEditor(); setStatus("Revision restored"); } catch (error) { setStatus(error.message, "error"); } }
async function create() { try { const project = await api("/api/projects", { method:"POST", body:JSON.stringify({ title:"Untitled document" }) }); state.projects.unshift(project); state.current = project; renderEditor(); setStatus("New document ready"); } catch (error) { setStatus(error.message, "error"); } }
async function exportDocx() { if (!state.current || state.busy) return; const button = $("exportDocx"); state.busy = true; setBusy(button, true, "Exporting..."); setStatus("Preparing DOCX..."); try { await save(); const response = await fetch(`/api/projects/${state.current.id}/export/docx`, { method:"POST" }); if (!response.ok) { const raw = await response.text(); let detail = "DOCX export failed"; try { detail = JSON.parse(raw).error || detail; } catch {} throw new Error(detail); } const blob = await response.blob(); const link = document.createElement("a"); const fallback = `${($("title").value || "document").replace(/[^a-zA-Z0-9._-]+/g, "-") || "document"}.docx`; const disposition = response.headers.get("content-disposition") || ""; const match = disposition.match(/filename="([^"]+)"/); link.href = URL.createObjectURL(blob); link.download = match?.[1] || fallback; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(link.href); setStatus("DOCX exported"); } catch (error) { setStatus(error.message, "error"); } finally { state.busy = false; setBusy(button, false); } }
async function importFile(file) { const status = $("importState"); const button = $("importProject"); if (!file || state.busy) return; if (!/\.(md|markdown|txt|docx)$/i.test(file.name)) { status.textContent = "Supported formats: Markdown, text, and DOCX."; status.className = "import-state error"; return; } state.busy = true; setBusy(button, true, "Importing..."); status.textContent = "Reading file..."; status.className = "import-state"; try { let payload = { fileName:file.name, title:file.name.replace(/\.(markdown|md|txt|docx)$/i, "") }; if (/\.docx$/i.test(file.name)) { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); payload.base64 = btoa(binary); } else payload.content = await file.text(); status.textContent = "Converting..."; const project = await api("/api/import", { method:"POST", body:JSON.stringify(payload) }); state.projects.unshift(project); state.current = project; renderEditor(); status.textContent = `Imported ${file.name}`; setStatus("Import complete"); } catch (error) { status.textContent = error.message; status.className = "import-state error"; setStatus("Import failed", "error"); } finally { state.busy = false; setBusy(button, false); $("fileInput").value = ""; } }
function selectionForEditor() { const editor = $("editor"); const start = editor.selectionStart; const end = editor.selectionEnd; return end > start ? { start, end, text: editor.value.slice(start, end) } : null; }
function renderProposal(result, original, preview, operation) {
  const selected = operation.changes?.[0]?.type === "replace_range";
  const label = selected ? "Selected passage" : "Full document";
  result.innerHTML = `<div class="proposal-label">${label} · line diff</div><div class="proposal-diff"><div><small>Changes</small><div class="diff-view">${diffLines(original, preview)}</div></div></div><div class="ai-actions"><button class="apply">Apply change</button><button class="reject">Reject</button></div>`;
  result.querySelector(".apply").onclick = async () => {
    result.querySelectorAll("button").forEach((button) => button.disabled = true);
    const change = operation.changes[0];
    if ($("editor").value !== state.proposalSource) { result.className = "ai-result error"; result.textContent = "Document changed while this proposal was being prepared. Generate a new proposal."; return; }
    const current = $("editor").value;
    const nextValue = change.type === "replace_range" ? current.slice(0, change.start) + change.content + current.slice(change.end) : change.content;
    recordEditorChange(nextValue); $("editor").value = nextValue;
    updateCount();
    try { await save(operation.baseRevision); result.classList.add("hidden"); setStatus("AI change applied"); }
    catch (error) { result.className = "ai-result error"; result.textContent = error.message; }
  };
  result.querySelector(".reject").onclick = () => { result.classList.add("hidden"); setStatus("Proposal rejected"); };
}
async function ask(task) {
  if (!state.current || state.busy) return;
  const result = $("aiResult"); const buttons = [...document.querySelectorAll("[data-task]")];
  const baseRevision = state.current.revision ?? (state.current.revisions || []).length;
  const content = $("editor").value; const selection = selectionForEditor();
  state.proposalSource = content;
  const controller = new AbortController(); state.aiAbortController = controller; state.busy = true; updateUndoButtons();
  buttons.forEach((button) => setBusy(button, true, "Working...")); result.classList.remove("hidden"); result.className = "ai-result";
  result.innerHTML = `<strong>${selection ? "Preparing selected passage..." : "Preparing proposal..."}</strong><pre></pre><div class="ai-actions"><button class="cancel">Cancel</button></div>`;
  result.querySelector(".cancel").onclick = () => controller.abort(); let preview = ""; let operation = null;
  try {
    const response = await fetch("/api/ai/propose/stream", { method:"POST", headers:{ "content-type":"application/json", accept:"text/event-stream" }, body:JSON.stringify({ task, content, revision:baseRevision, selectionStart:selection?.start, selectionEnd:selection?.end }), signal:controller.signal });
    if (!response.ok) { const raw = await response.text(); let detail = "AI request failed"; try { detail = JSON.parse(raw).error || detail; } catch {} throw new Error(detail); }
    if (!response.body) throw new Error("Streaming is not available in this browser");
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let done = false;
    const consume = (block) => { for (const line of block.split(/\r?\n/)) { if (!line.startsWith("data:")) continue; const event = JSON.parse(line.slice(5).trim()); if (event.type === "meta") result.querySelector("strong").textContent = `${event.provider}${event.model ? ` · ${event.model}` : ""}`; if (event.type === "text") { preview += event.delta; result.querySelector("pre").textContent = preview; } if (event.type === "error") throw new Error(event.error); if (event.type === "done") { operation = event.operation; preview = event.preview; done = true; } } };
    while (!done) { const chunk = await reader.read(); buffer += decoder.decode(chunk.value || new Uint8Array(), { stream:!chunk.done }); const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() || ""; blocks.forEach(consume); if (chunk.done) { if (buffer) consume(buffer); break; } }
    if (!operation) throw new Error("AI provider ended without a proposal");
    renderProposal(result, selection?.text || content, preview, operation);
  } catch (error) { if (error.name === "AbortError" || controller.signal.aborted) { result.className = "ai-result cancelled"; result.textContent = "Proposal canceled"; setStatus("AI proposal canceled"); } else { result.textContent = error.message; result.className = "ai-result error"; } }
  finally { if (state.aiAbortController === controller) state.aiAbortController = null; state.busy = false; buttons.forEach((button) => setBusy(button, false)); updateUndoButtons(); }
}
function renderProviderStatus(status) { if (!status) return; const label = status.provider === "local" ? "Local" : "OpenAI-compatible"; $("providerStatus").textContent = `● ${label}`; $("providerStatus").className = `status-dot${status.configured ? "" : " warning"}`; $("providerMeta").textContent = status.provider === "local" ? `Local copilot · ${status.model}` : status.configured ? `${status.model} · ready for reviewable edits` : `${status.model} · add GENOFFICE_AI_API_KEY on the server`; }
async function loadAiStatus() { try { renderProviderStatus(await api("/api/ai/status")); } catch (error) { $("providerMeta").textContent = error.message; } }
async function openAiSettings() { try { const settings = await api("/api/ai/settings"); $("aiProvider").value = settings.provider; $("aiBaseUrl").value = settings.baseUrl; $("aiModel").value = settings.model; $("aiSettingsState").textContent = settings.configured ? "Provider is ready." : "Provider selected; server API key is not configured."; $("aiSettingsDialog").showModal(); } catch (error) { setStatus(error.message, "error"); } }
async function saveAiSettings(event) { event.preventDefault(); const stateNode = $("aiSettingsState"); const button = event.target.querySelector("button[type=submit]"); setBusy(button, true, "Saving..."); stateNode.textContent = "Saving settings..."; try { const settings = await api("/api/ai/settings", { method:"PUT", body:JSON.stringify({ provider:$("aiProvider").value, baseUrl:$("aiBaseUrl").value, model:$("aiModel").value }) }); renderProviderStatus(settings); stateNode.textContent = settings.configured ? "Provider is ready." : "Saved. Add GENOFFICE_AI_API_KEY on the server to enable remote calls."; setStatus("AI settings saved"); } catch (error) { stateNode.textContent = error.message; } finally { setBusy(button, false); } }
$("editor").addEventListener("input", () => { recordEditorChange($("editor").value); updateCount(); queueSave(); }); $("title").addEventListener("input", () => { queueSave(); }); $("undoEdit").onclick = undoEdit; $("redoEdit").onclick = redoEdit; $("newProject").onclick = create; $("exportDocx").onclick = exportDocx; $("aiSettings").onclick = openAiSettings; $("closeAiSettings").onclick = () => $("aiSettingsDialog").close(); $("cancelAiSettings").onclick = () => $("aiSettingsDialog").close(); $("aiSettingsForm").addEventListener("submit", saveAiSettings); $("importProject").onclick = () => $("fileInput").click(); $("fileInput").onchange = (event) => importFile(event.target.files[0]); document.querySelectorAll("[data-task]").forEach((b) => b.onclick = () => ask(b.dataset.task));
$("editor").addEventListener("select", updateSelectionState);
$("editor").addEventListener("mouseup", updateSelectionState);
$("editor").addEventListener("keyup", updateSelectionState);
$("editor").addEventListener("blur", updateSelectionState);
document.addEventListener("selectionchange", () => { if (document.activeElement === $("editor")) updateSelectionState(); });
$("editor").addEventListener("keydown", (event) => { if (!(event.metaKey || event.ctrlKey)) return; const key = event.key.toLowerCase(); if (key !== "z" && key !== "y") return; event.preventDefault(); (event.shiftKey || key === "y") ? redoEdit() : undoEdit(); });
$("importProject").ondragover = (event) => event.preventDefault(); $("importProject").ondrop = (event) => { event.preventDefault(); importFile(event.dataTransfer.files[0]); };
const boot = async () => { await loadAiStatus(); state.projects = await api("/api/projects"); if (!state.projects.length) await create(); else await openProject(state.projects[0].id); }; boot().catch((error) => { setStatus(error.message, "error"); });
