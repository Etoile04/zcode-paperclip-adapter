import type { AdapterSessionCodec, ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  ADAPTER_TYPE,
  ZCODE_MODELS,
} from "../shared/constants.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listZcodeSkills, syncZcodeSkills } from "./skills.js";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = typeof record["sessionId"] === "string" ? record["sessionId"] : null;
    if (!sessionId) return null;
    // cwd is optional on input: hosts may persist bare { sessionId } records.
    const cwd = typeof record["cwd"] === "string" ? record["cwd"] : undefined;
    return cwd ? { sessionId, cwd } : { sessionId };
  },
  serialize(params) {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
    const record = params as Record<string, unknown>;
    const sessionId = typeof record["sessionId"] === "string" ? record["sessionId"] : null;
    if (!sessionId) return null;
    const cwd = typeof record["cwd"] === "string" ? record["cwd"] : undefined;
    return cwd ? { sessionId, cwd } : { sessionId };
  },
  getDisplayId(params) {
    if (typeof params !== "object" || params === null) return null;
    const sessionId = (params as Record<string, unknown>)["sessionId"];
    if (typeof sessionId !== "string" || !sessionId) return null;
    return sessionId.replace(/^sess_/, "").slice(0, 12);
  },
};

/**
 * Capability flags + skills hooks from the in-repo ServerAdapterModule (not
 * yet in the npm-published @paperclipai/adapter-utils types). The host reads
 * them to decide whether the agent form shows the Instructions / Skills
 * sections and to drive skill sync.
 */
interface ZcodeServerAdapterModule extends ServerAdapterModule {
  supportsInstructionsBundle?: boolean;
  listSkills?: typeof listZcodeSkills;
  syncSkills?: typeof syncZcodeSkills;
}

export function createServerAdapter(): ZcodeServerAdapterModule {
  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    sessionCodec,
    supportsInstructionsBundle: true,
    listSkills: listZcodeSkills,
    syncSkills: syncZcodeSkills,
    models: ZCODE_MODELS.map((model) => ({ id: model.id, label: model.label })),
    agentConfigurationDoc: `# zcode_local agent configuration

Runs the ZCode CLI (GLM coding agent, the agent runtime shipped with ZCode Desktop) as a local child process, the same way claude_local drives the Claude Code CLI.

## Use when

- You want a GLM-powered (Z.ai / BigModel) coding agent as a Paperclip employee.
- ZCode Desktop is installed on the machine running Paperclip, or the zcode binary is on PATH.
- You want session continuity across heartbeats (zcode --resume).

## Don't use when

- You need Claude-specific features (Claude OAuth, Claude skills/plugins semantics).
- The machine running Paperclip has no ZCode install or model credentials.
- You need per-agent model selection: zcode has no --model flag; every agent uses the model configured in ~/.zcode/cli/config.json.

## Core fields

- \`cwd\` (required): working directory for the agent; sessions resume only when it stays stable.
- \`zcodeCommand\` (optional): explicit zcode/zcode-agent binary path. Auto-detected otherwise (~/.zcode/server/agents/glm/zcode-agent, then the app bundle, then PATH).
- \`mode\` (optional): zcode permission mode — yolo (default), build, edit, or plan.
- \`timeoutSec\` (optional): hard timeout per run, default 1800.
- \`promptTemplate\` (optional): Mustache-style template rendered with {agent}, {company}, {run}, {context}. Defaults to Paperclip's canonical agent contract (issue dispositions, interactions API). The full per-run prompt is assembled from the Paperclip wake payload, session handoff, task markdown, this template, and your instructions file — mirroring claude_local.
- \`bootstrapPrompt\` (optional): one-off template rendered only on the first (non-resumed) run.
- \`instructionsFilePath\` (optional): file whose contents are appended to the prompt on fresh sessions only (skipped on resumed sessions to save tokens).
- \`maxTurnsPerRun\` (optional): accepted for form compatibility but the zcode CLI has no --max-turns flag; only timeoutSec bounds the run.
- \`disallowedTools\` (optional): tool names passed to --disallowed-tools (e.g. ["Bash", "WebSearch"]).
- \`extraArgs\` (optional): additional CLI flags appended verbatim (whitespace-separated).
- \`env\` / \`envVars\` (optional): extra environment variables for the child process.
- \`persistSession\` (optional, default true): resume the zcode session across runs; set false for a fresh session every run.

## Model

The adapter reports the models known to the local ZCode install, but zcode has no --model flag: the effective model comes from \`model\` in ~/.zcode/cli/config.json (e.g. "builtin:bigmodel-coding-plan/GLM-5.3"). Configure it once per machine.

## Reporting to Paperclip

The default prompt template teaches the agent to call the Paperclip HTTP API with curl using \$PAPERCLIP_API_URL / \$PAPERCLIP_API_KEY plus the run-scoped PAPERCLIP_* env vars injected by the server.
`,
  };
}
