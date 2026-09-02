import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const probe = http.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

const dataDir = await mkdtemp(join(tmpdir(), "genoffice-server-test-"));
const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL(".", import.meta.url),
  env: { ...process.env, PORT: String(port), GENOFFICE_DATA_DIR: dataDir },
  stdio: ["ignore", "ignore", "pipe"],
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start");
}

try {
  await waitForServer();
  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "季度复盘", content: "# 本季度进展" }),
  });
  assert.equal(createdResponse.status, 201);
  const project = await createdResponse.json();

  for (const message of [
    { role: "user", content: "把这段内容改得更专业" },
    { role: "assistant", content: "已生成修改建议" },
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    assert.equal(response.status, 201);
  }

  const stored = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`).then((response) => response.json());
  assert.deepEqual(stored.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "把这段内容改得更专业" },
    { role: "assistant", content: "已生成修改建议" },
  ]);
  assert.ok(stored.conversationUpdatedAt);
  console.log("Server conversation contract passed");
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  await rm(dataDir, { recursive: true, force: true });
}
