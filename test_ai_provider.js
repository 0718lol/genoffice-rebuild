import assert from "node:assert/strict";
import http from "node:http";
import { propose, providerStatus, streamPropose } from "./ai-provider.js";

const status = providerStatus({ provider: "local", model: "test-model", baseUrl: "https://example.com/v1" });
assert.equal(status.provider, "local");
assert.equal(status.configured, true);
assert.equal(status.apiKeyConfigured, false);

const result = await propose({
  task: "Continue this document with a practical next section",
  content: "# Launch plan\n\nShip the first milestone.",
  revision: 4,
}, { provider: "local", model: "test-model", baseUrl: "https://example.com/v1" });

assert.equal(result.provider, "local");
assert.equal(result.operation.baseRevision, 4);
assert.match(result.preview, /下一步/);
assert.equal(result.operation.changes[0].type, "replace_document");

const selectedResult = await propose({
  task: "Improve writing",
  content: "# Launch plan\n\nShip the first milestone.",
  selectionStart: 15,
  selectionEnd: 37,
  revision: 5,
}, { provider: "local", model: "test-model", baseUrl: "https://example.com/v1" });
assert.equal(selectedResult.operation.changes[0].type, "replace_range");
assert.equal(selectedResult.operation.changes[0].start, 15);
assert.equal(selectedResult.operation.changes[0].end, 37);

const chineseSummary = await propose({
  task: "请将内容总结为三个简洁的要点",
  content: "这是一份产品发布计划。",
  revision: 6,
}, { provider: "local", model: "test-model", baseUrl: "https://example.com/v1" });
assert.match(chineseSummary.preview, /内容摘要/);

const events = [];
for await (const event of streamPropose({
  task: "Continue this document",
  content: "# Stream test",
  revision: 2,
}, { provider: "local", model: "test-model", baseUrl: "https://example.com/v1" })) {
  events.push(event);
}
assert.equal(events[0].type, "meta");
assert.ok(events.some((event) => event.type === "text"));
assert.equal(events.at(-1).type, "done");
assert.equal(events.at(-1).operation.baseRevision, 2);

const previousKey = process.env.GENOFFICE_AI_API_KEY;
process.env.GENOFFICE_AI_API_KEY = "unit-test-key";
const remoteServer = http.createServer((request, response) => {
  assert.equal(request.headers.authorization, "Bearer unit-test-key");
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const payload = JSON.parse(raw);
    assert.match(payload.messages[1].content, /Selected passage/);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "# Remote" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " proposal" } }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
const remotePort = remoteServer.address().port;
const remoteEvents = [];
for await (const event of streamPropose({ task: "Improve this document", content: "# Remote", revision: 8, selectionStart: 0, selectionEnd: 9 }, { provider: "openai-compatible", baseUrl: `http://127.0.0.1:${remotePort}/v1`, model: "fixture-model" })) {
  remoteEvents.push(event);
}
await new Promise((resolve) => remoteServer.close(resolve));
if (previousKey === undefined) delete process.env.GENOFFICE_AI_API_KEY;
else process.env.GENOFFICE_AI_API_KEY = previousKey;
assert.equal(remoteEvents.at(-1).preview, "# Remote proposal");
assert.equal(remoteEvents.at(-1).provider, "openai-compatible");
assert.equal(remoteEvents.at(-1).operation.changes[0].type, "replace_range");
console.log("AI provider contract passed");
