/**
 * Local validation of instructions + skills injection, independent of the host.
 * Usage: node scripts/smoke-skills.mjs
 */
import { createServerAdapter } from "../dist/server/index.js";
import { readdirSync, readlinkSync } from "node:fs";
import path from "node:path";

const adapter = createServerAdapter();
const skillsHome = path.join(process.env.HOME, ".agents", "skills");
const skillSource = process.env.SKILL_SOURCE
  ?? path.join(process.env.HOME, "paperclip", "skills", "paperclip");
const instructionsPath = process.env.INSTRUCTIONS_PATH
  ?? path.join(process.env.HOME, "INSTRUCTIONS.md");

const notes = [];
const result = await adapter.execute({
  runId: `run_skills_smoke_${Date.now()}`,
  agent: {
    id: "agent_smoke",
    companyId: "company_smoke",
    name: "Zcode Smoke Agent",
    adapterType: "zcode_local",
    adapterConfig: {},
  },
  runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
  config: {
    cwd: "/tmp/zcode-fixture-cwd",
    promptTemplate: "Reply with just the word: ready",
    instructionsFilePath: instructionsPath,
    paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/paperclip"] },
    paperclipRuntimeSkills: [
      { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: skillSource },
    ],
  },
  context: {},
  onLog: async () => {},
  onMeta: async (meta) => { notes.push(...(meta.commandNotes ?? [])); },
  authToken: "smoke-token",
});

console.log("== exitCode:", result.exitCode, "| response:", result.summary);
console.log("== commandNotes:"); for (const n of notes) console.log("  -", n);

const target = path.join(skillsHome, "paperclip");
try {
  const link = readlinkSync(target);
  console.log("== symlink:", target, "->", link, link === skillSource ? "(CORRECT)" : "(UNEXPECTED)");
} catch (e) {
  console.log("== symlink MISSING:", e.message);
}
try {
  const md = readdirSync(target).slice(0, 5);
  console.log("== skill dir contents:", md.join(", "));
} catch {}
