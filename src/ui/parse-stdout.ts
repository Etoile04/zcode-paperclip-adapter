/**
 * UI-side re-exports. The actual parser implementation lives in src/ui-parser.ts,
 * which is fully self-contained so it can be served to and evaluated in the
 * Paperclip web UI sandbox.
 */
export { createStdoutParser, parseStdoutLine } from "../ui-parser.js";
