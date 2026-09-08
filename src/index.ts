/**
 * zcode-paperclip-adapter package root.
 *
 * Exposes the adapter metadata plus the server factory consumed by the
 * Paperclip adapter plugin loader.
 */
import { ADAPTER_LABEL, ADAPTER_TYPE, ZCODE_MODELS } from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;
export const models = ZCODE_MODELS.map((model) => ({ id: model.id, label: model.label }));
export { createServerAdapter, sessionCodec } from "./server/index.js";
export { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE } from "./server/paperclip-prompt.js";
export { createServerAdapter as default } from "./server/index.js";
