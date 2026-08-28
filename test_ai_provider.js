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
assert.match(result.preview, /Next steps/);
assert.equal(result.operation.changes[0].type, "replace_document");

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
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "# Remote" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " proposal" } }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
const remotePort = remoteServer.address().port;
const remoteEvents = [];
for await (const event of streamPropose({ task: "Improve this document", content: "# Remote", revision: 8 }, { provider: "openai-compatible", baseUrl: `http://127.0.0.1:${remotePort}/v1`, model: "fixture-model" })) {
  remoteEvents.push(event);
}
await new Promise((resolve) => remoteServer.close(resolve));
if (previousKey === undefined) delete process.env.GENOFFICE_AI_API_KEY;
else process.env.GENOFFICE_AI_API_KEY = previousKey;
assert.equal(remoteEvents.at(-1).preview, "# Remote proposal");
assert.equal(remoteEvents.at(-1).provider, "openai-compatible");
console.log("AI provider contract passed");
