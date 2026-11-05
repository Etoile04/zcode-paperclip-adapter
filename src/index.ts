/**
 * zcode-paperclip-adapter package root.
 *
 * Exposes the adapter metadata plus the server factory consumed by the
 * Paperclip adapter plugin loader.
 */
import { ADAPTER_LABEL, ADAPTER_TYPE, ZCODE_MODELS } from "./shared/constants.js";
import {
  createServerAdapter as createServerAdapterBase,
  sessionCodec,
} from "./server/index.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;
export const models = ZCODE_MODELS.map((model) => ({ id: model.id, label: model.label }));

/**
 * Host-visible capability flags.
 *
 * These are declared on the package ENTRY module on purpose. The Paperclip
 * host hot-reloads an external adapter by re-importing the package entry
 * (`dist/index.js`) with a cache-busting query string; the entry's own
 * imports stay in the ESM cache, so a capability that only existed in
 * `./server/index.js` would need a full Paperclip restart before the host
 * observed it. Declaring the flags here lets
 * `POST /api/adapters/zcode_local/reload` pick a change up without a
 * restart.
 *
 * `test/local-agent-jwt.test.ts` asserts these stay in sync with the flags
 * on the module returned by `./server/index.js`.
 */
export const serverAdapterCapabilities = {
  /**
   * The host mints a per-run local agent JWT (HS256, signing key derived per
   * instance + company) and injects it into the child process environment as
   * `PAPERCLIP_API_KEY` — see `execute.ts` buildChildEnv(). Without this flag
   * the host passes `ctx.authToken === null`, the child gets no Paperclip
   * credential at all, and every `/api` call answers 401.
   */
  supportsLocalAgentJwt: true,
} as const;

/**
 * The server module the Paperclip plugin loader consumes.
 *
 * The base factory in `./server/index.js` already declares the same
 * capability; re-applying the entry-level flags here keeps the two in
 * agreement and makes the flags survive an entry-only hot-reload.
 */
export function createServerAdapter() {
  return { ...createServerAdapterBase(), ...serverAdapterCapabilities };
}

export { sessionCodec };
export { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE } from "./server/paperclip-prompt.js";
export { createServerAdapter as default };
