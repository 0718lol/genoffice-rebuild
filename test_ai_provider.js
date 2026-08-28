import assert from "node:assert/strict";
import { propose, providerStatus } from "./ai-provider.js";

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
console.log("AI provider contract passed");
