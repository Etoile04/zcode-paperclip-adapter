/**
 * Smoke test: drives the built adapter exactly the way the Paperclip host does.
 * Usage: node scripts/smoke.mjs [cwd]
 */
import { createServerAdapter } from "../dist/server/index.js";

const cwd = process.argv[2] ?? "/tmp/zcode-fixture-cwd";
const adapter = createServerAdapter();

const agent = {
  id: "agent_smoke",
  companyId: "company_smoke",
  name: "Zcode Smoke Agent",
  adapterType: "zcode_local",
  adapterConfig: {},
};

const env = await adapter.testEnvironment({
  companyId: agent.companyId,
  adapterType: "zcode_local",
  config: { cwd },
});
console.log("== testEnvironment ==");
console.log(JSON.stringify(env, null, 2));

async function runOnce(sessionParams, prompt) {
  return adapter.execute({
    runId: `run_smoke_${Date.now()}`,
    agent,
    runtime: { sessionId: null, sessionParams, sessionDisplayId: null, taskKey: null },
    config: { cwd },
    context: {},
    onLog: async () => {},
    authToken: "smoke-token",
    ...(prompt ? {} : {}),
    ...(prompt ? { overridePrompt: prompt } : {}),
  });
}

console.log("\n== execute #1 (fresh session) ==");
const first = await runOnce(null);
console.log(JSON.stringify({ ...first, resultJson: "<omitted>" }, null, 2));

console.log("\n== execute #2 (resume) ==");
const second = await runOnce(first.sessionParams);
console.log(JSON.stringify({ ...second, resultJson: "<omitted>" }, null, 2));

console.log("\n== summary ==");
console.log("run1:", { exitCode: first.exitCode, model: first.model, provider: first.provider, usage: first.usage, summary: first.summary?.slice(0, 120), session: first.sessionParams });
console.log("run2:", { exitCode: second.exitCode, model: second.model, usage: second.usage, summary: second.summary?.slice(0, 120), session: second.sessionParams, resumed: second.sessionParams?.sessionId === first.sessionParams?.sessionId });
