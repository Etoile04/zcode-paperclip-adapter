/**
 * Replay a Paperclip heartbeat-run log through the built ui-parser and print
 * the resulting transcript — used to validate transcript rendering E2E.
 * Usage: PC_TOKEN=... node scripts/replay-log.mjs <runId>
 */
import { createStdoutParser } from "../dist/ui-parser.js";

const token = process.env.PC_TOKEN;
const runId = process.argv[2];
if (!token || !runId) {
  console.error("Usage: PC_TOKEN=... node scripts/replay-log.mjs <runId>");
  process.exit(1);
}

const parser = createStdoutParser();
const counts = {};
let toolResults = 0;
let toolPairs = 0;
let offset = 0;
let assistantText = "";
let thinkingChars = 0;

while (true) {
  const res = await fetch(`http://127.0.0.1:3101/api/heartbeat-runs/${runId}/log?offset=${offset}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (typeof body.content !== "string" || body.content.length === 0) break;
  for (const line of body.content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record.stream !== "stdout") continue;
    for (const raw of String(record.chunk ?? "").split("\n")) {
      for (const t of parser.parseLine(raw, record.ts ?? new Date().toISOString())) {
        counts[t.kind] = (counts[t.kind] ?? 0) + 1;
        if (t.kind === "assistant") assistantText += t.text;
        if (t.kind === "thinking") thinkingChars += t.text.length;
        if (t.kind === "tool_result") {
          toolResults++;
          if (t.toolUseId) toolPairs++;
        }
        if (t.kind === "result") {
          console.log("RESULT entry:", JSON.stringify(t).slice(0, 240));
        }
      }
    }
  }
  if (typeof body.nextOffset !== "number" || body.nextOffset <= offset) break;
  offset = body.nextOffset;
}

console.log("entry counts:", JSON.stringify(counts));
console.log(`tool_results: ${toolResults} (with toolUseId: ${toolPairs})`);
console.log(`thinking chars: ${thinkingChars}`);
console.log("assistant text (first 300):", JSON.stringify(assistantText.slice(0, 300)));
