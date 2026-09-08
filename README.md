# zcode-paperclip-adapter

A [Paperclip](https://github.com/paperclipai/paperclip) external adapter that runs the **ZCode CLI** (the GLM coding agent shipped with ZCode Desktop) as a managed employee in a Paperclip company — the same way the built-in `claude_local` adapter drives the Claude Code CLI.

- **Agent runtime**: local `zcode` binary spawned headless (`--prompt --output-format stream-json`), tested against zcode 0.16.5.
- **Session continuity**: zcode sessions resume across heartbeats (`--resume`), with automatic retry on dead sessions.
- **Readable transcripts**: a browser-safe ui-parser turns zcode's NDJSON event stream into Paperclip transcript entries — assistant + reasoning deltas, paired tool-call cards, init/result summaries with token usage.
- **Instructions & Skills**: supports Paperclip's managed instructions bundle and skill sync (desired company skills are symlinked into `~/.agents/skills/`, which zcode discovers automatically).
- **Usage & billing**: per-run token usage extracted from the run result; billing type inferred from the configured provider (coding-plan providers report as `subscription`).

## How it works

`execute()` spawns the local zcode binary headless:

```
<zcode> --prompt <rendered heartbeat prompt> \
        --output-format stream-json \
        --mode yolo|build|edit|plan \
        --cwd <workspace> \
        [--resume <sess_...>] \
        [--disallowed-tools Bash,...]
```

The prompt is assembled exactly like `claude_local` does: Paperclip wake payload → session handoff → task markdown → the canonical Paperclip agent contract (`DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE`) → your instructions file (fresh sessions only, to save tokens). The NDJSON event stream is parsed server-side for session id / usage / model, and in the browser by the bundled ui-parser into a readable transcript (assistant + thinking deltas, paired tool cards, init/result entries).

## Requirements

- **ZCode Desktop installed** on the machine running Paperclip (binary auto-detected: `~/.zcode/server/agents/glm/zcode-agent` shim → `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` + node → `zcode` on PATH), or set the `zcodeCommand` config field.
- **`~/.zcode/cli/config.json` with an explicit model provider.** The zcode CLI has no `--model` flag; every agent uses the machine-wide default. Example:

  ```json
  {
    "model": "builtin:bigmodel-coding-plan/GLM-5.3",
    "provider": {
      "builtin:bigmodel-coding-plan": {
        "kind": "anthropic",
        "options": {
          "apiKey": "<your bigmodel coding-plan key>",
          "baseURL": "https://open.bigmodel.cn/api/anthropic"
        }
      }
    }
  }
  ```

  (Copy the provider entry from ZCode Desktop's `~/.zcode/v2/config.json`.)

## Install

Clone and install dependencies (the Paperclip host resolves the package's own `node_modules`):

```sh
git clone https://github.com/Etoile04/zcode-paperclip-adapter.git
cd zcode-paperclip-adapter
npm install && npm run build
```

From a Paperclip board with instance-admin access, or via the API:

```sh
curl -X POST "$PAPERCLIP_API_URL/api/adapters/install" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"packageName": "/absolute/path/to/zcode-paperclip-adapter", "isLocalPath": true}'
```

Dev iteration: rebuild (`npm run build`) then hot-reload without restarting Paperclip:

```sh
curl -X POST "$PAPERCLIP_API_URL/api/adapters/zcode_local/reload" -H "Authorization: Bearer $ADMIN_KEY"
```

## Agent adapter config fields

| Field | Default | Description |
|---|---|---|
| `cwd` | — (required) | Working directory; ignored when Paperclip resolves an execution workspace for the run. Sessions resume only when the cwd is stable or unknown. |
| `zcodeCommand` | auto-detect | Explicit zcode / zcode-agent binary path. |
| `mode` | `yolo` | zcode permission mode: `yolo`, `build`, `edit`, `plan`. |
| `timeoutSec` | `1800` | Hard timeout per run. |
| `promptTemplate` | Paperclip canonical contract | Mustache-style template over `{agent, company, run, context}`. |
| `bootstrapPrompt` | — | One-off template rendered only on the first (non-resumed) run. |
| `instructionsFilePath` | — | File appended to the prompt on fresh sessions only. |
| `disallowedTools` | — | Tool names for `--disallowed-tools` (comma/space list). |
| `extraArgs` | — | Extra CLI flags (whitespace-separated). |
| `env` / `envVars` | — | Extra child env vars (object, or `K=V` lines). |
| `persistSession` | `true` | Resume the zcode session across heartbeats. |
| `maxTurnsPerRun` | — | Accepted for form compatibility; the zcode CLI has no `--max-turns`, only `timeoutSec` applies. |

## Instructions & Skills

The adapter declares `supportsInstructionsBundle: true` and implements `listSkills` / `syncSkills`:

- **Instructions** — the host manages `instructionsFilePath` in `adapterConfig`; the file's contents are appended to the prompt on fresh sessions only (resumed sessions already carry them in history — the same trade-off claude_local makes). Editing instructions mid-session takes effect after the session resets (agent runtime-state → reset session).
- **Skills** — the host passes company skills via `config.paperclipRuntimeSkills` and the agent's selection via `config.paperclipSkillSync.desiredSkills`. Desired skills are symlinked into `~/.agents/skills/<runtimeName>` (zcode's global user-skills dir, auto-discovered; foreign directories are never overwritten) on every run, and removed when deselected.

Host support matrix: these capability signals are read by Paperclip hosts that support module-declared capabilities (the in-repo `ServerAdapterModule` contract — `adapter.supportsInstructionsBundle ?? false` and `Boolean(adapter.listSkills || adapter.syncSkills)`). Older hosts with hardcoded per-type capability lists will not show the Instructions/Skills editor UI for external adapters regardless of what the module declares, and their runtime may not inject `paperclipRuntimeSkills` either — verify with a run whose `adapter.invoke` event shows the `skills sync: …` command note. Also note: on tsx dev hosts, the adapter hot-reload (`POST /api/adapters/:type/reload`) only refreshes the package entry file — changes in submodules (execute/skills) require a server restart.

## Behavior notes & limits

- **Model selection is machine-wide** (no `--model` flag). The `models` metadata is informational.
- **Prompt is passed via argv**, not stdin (zcode has no stdin prompt mode). Very large prompts (>250 KB single-arg limit) would fail; heartbeat prompts are normally far below that.
- **Resume**: prior session id is taken from `runtime.sessionParams` with a fallback to the legacy `runtime.sessionId`; a known-different cwd forces a fresh session. If zcode reports `Session not found`, the adapter retries once without `--resume` and clears the stored session.
- **Auth token**: the adapter does not set `supportsLocalAgentJwt` (the local-JWT path hung one host build during testing); Paperclip falls back to agent API-key auth, which worked in end-to-end testing.
- **Usage/billing**: token usage comes from the final `result` event; `billingType` is inferred from the provider id (`coding-plan`/`start-plan` → `subscription`).
- Some documented-but-unimplemented zcode flags (`--max-turns`, `--allowed-tools`, `--settings`, `--permission-mode`) are rejected by the 0.16.5 parser — do not pass them via `extraArgs`.

## Development

```sh
npm install
npm run build     # tsc → dist/
npm test          # vitest, replays real fixtures from fixtures/
node scripts/smoke.mjs [cwd]          # drive execute() + testEnvironment() directly
PC_TOKEN=<admin key> node scripts/replay-log.mjs <runId>   # replay a run log through the ui-parser
```

`fixtures/` contains real captured stream-json output (success / invalid-resume / valid-resume) that backs the parser tests.

### Vendored helpers

`src/server/paperclip-prompt.ts` vendors `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE`, `joinPromptSections`, `renderPaperclipWakePrompt` and `applyPaperclipWorkspaceEnv` from paperclipai/paperclip (MIT), because the npm-published `@paperclipai/adapter-utils` 0.3.1 does not export them yet. Replace with direct imports once published.

## License

MIT. Prompt helpers vendored from [paperclipai/paperclip](https://github.com/paperclipai/paperclip) (MIT).
