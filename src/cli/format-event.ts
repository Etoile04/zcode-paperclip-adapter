import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import pc from "picocolors";
import { createStdoutParser } from "../ui-parser.js";
import { ADAPTER_TYPE } from "../shared/constants.js";

const parser = createStdoutParser();

function formatEntry(entry: TranscriptEntry, debug: boolean): string {
  switch (entry.kind) {
    case "init":
      return pc.dim(`[zcode] session ${entry.sessionId} · model ${entry.model}`);
    case "user":
      return pc.blue(`❯ ${entry.text}`);
    case "assistant":
      return entry.delta ? pc.cyan(entry.text) : pc.cyan(`✔ ${entry.text}`);
    case "thinking":
      return pc.dim(entry.delta ? entry.text : `… ${entry.text}`);
    case "tool_call":
      return pc.magenta(
        `⚙ ${entry.name}${entry.toolUseId ? ` (${entry.toolUseId.slice(0, 12)})` : ""} ${pc.dim(JSON.stringify(entry.input))}`,
      );
    case "tool_result":
      return entry.isError
        ? pc.red(`✗ ${entry.content}`)
        : pc.green(`↳ ${entry.content.slice(0, 400)}`);
    case "result":
      return pc.bold(
        `\n■ done · ${entry.subtype} · in ${entry.inputTokens} / out ${entry.outputTokens} tokens`,
      );
    case "stderr":
      return pc.bgRed(pc.white(entry.text));
    case "system":
      return pc.yellow(`[system] ${entry.text}`);
    case "stdout":
    default:
      return debug ? pc.gray(entry.text) : entry.text;
  }
}

export function formatStdoutEvent(line: string, debug: boolean): void {
  for (const entry of parser.parseLine(line, new Date().toISOString())) {
    const text = formatEntry(entry, debug);
    if (text) console.log(text);
  }
}

export const cliAdapter = {
  type: ADAPTER_TYPE,
  formatStdoutEvent,
};
