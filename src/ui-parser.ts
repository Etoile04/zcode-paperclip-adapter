/**
 * Browser-safe stdout parser for the zcode_local Paperclip adapter.
 *
 * This module is evaluated in the Paperclip web UI sandbox, so it must be
 * fully self-contained: no runtime imports, no Node or DOM APIs, no
 * top-level side effects, and it must never throw on malformed input.
 *
 * ZCode headless output (`zcode --prompt ... --output-format stream-json`)
 * is NDJSON: one JSON envelope per line with the shape
 *   { type, payload, seq, sessionId, timestamp, ... }
 * followed by a final `{ type: "result", ... }` line.
 */
import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function modelRefToString(payload: Record<string, unknown>): string | null {
  const model = payload["model"];
  if (typeof model === "string") return model;
  const ref = payload["modelRef"];
  if (isRecord(ref)) {
    const providerId = str(ref["providerId"]);
    const modelId = str(ref["modelId"]);
    if (providerId && modelId) return `${providerId}/${modelId}`;
  }
  return null;
}

function parseStreaming(payload: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const kind = str(payload["kind"]) ?? "";
  const delta = str(payload["delta"]) ?? "";

  if (kind === "text_delta") {
    if (!delta) return [];
    return [{ kind: "assistant", ts, text: delta, delta: true }];
  }

  if (kind === "reasoning_delta" || kind === "thinking_delta" || kind === "reasoning") {
    if (!delta) return [];
    return [{ kind: "thinking", ts, text: delta, delta: true }];
  }

  if (kind === "tool_call") {
    const toolName = str(payload["toolName"]) ?? "unknown";
    const toolUseId = str(payload["toolCallId"]) ?? undefined;
    const input = isRecord(payload["input"])
      ? payload["input"]
      : delta
        ? (safeJsonParse(delta) ?? {})
        : {};
    return [{ kind: "tool_call", ts, name: toolName, input, toolUseId }];
  }

  // start / finish / text_start / text_end / tool_input_* carry no transcript content.
  return [];
}

function parseToolUpdated(payload: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const kind = str(payload["kind"]) ?? "";
  const toolCallId = str(payload["toolCallId"]);
  if (!toolCallId) return [];

  if (kind === "result") {
    const result = isRecord(payload["result"]) ? payload["result"] : {};
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: toolCallId,
        content: stringifyContent(result["content"] ?? result),
        isError: result["success"] === false,
      },
    ];
  }

  if (kind === "error") {
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: toolCallId,
        content: stringifyContent(payload["message"] ?? payload["error"] ?? "tool error"),
        isError: true,
      },
    ];
  }

  // scheduled / started / batch are lifecycle noise.
  return [];
}

function parseResultLine(
  envelope: Record<string, unknown>,
  payload: Record<string, unknown>,
  ts: string,
): TranscriptEntry[] {
  // The final result line carries response/usage/projection at the envelope top level.
  const source = str(envelope["response"]) === null && Object.keys(payload).length > 0 ? payload : envelope;
  const usage = isRecord(source["usage"]) ? source["usage"] : {};
  const projection = isRecord(source["projection"]) ? source["projection"] : {};
  return [
    {
      kind: "result",
      ts,
      text: str(source["response"]) ?? "",
      inputTokens: num(usage["inputTokens"]),
      outputTokens: num(usage["outputTokens"]),
      cachedTokens: num(usage["cacheReadTokens"]),
      costUsd: 0,
      subtype: str(projection["status"]) ?? "unknown",
      isError: false,
      errors: [],
    },
  ];
}

export function createStdoutParser(): {
  parseLine: (line: string, ts: string) => TranscriptEntry[];
  reset: () => void;
} {
  let emittedInit = false;

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) return [{ kind: "stdout", ts, text: trimmed }];
      envelope = parsed;
    } catch {
      return [{ kind: "stdout", ts, text: trimmed }];
    }

    const type = str(envelope["type"]) ?? "";
    const payload = isRecord(envelope["payload"]) ? envelope["payload"] : {};

    switch (type) {
      case "turn.started": {
        const input = str(payload["input"]);
        return input ? [{ kind: "user", ts, text: input }] : [];
      }
      case "model.streaming":
        return parseStreaming(payload, ts);
      case "tool.updated":
        return parseToolUpdated(payload, ts);
      case "result":
        return parseResultLine(envelope, payload, ts);
      case "session.updated": {
        // The first session.updated carrying a model ref announces the run identity.
        if (!emittedInit) {
          const model = modelRefToString(payload);
          const sessionId = str(envelope["sessionId"]);
          if (model && sessionId) {
            emittedInit = true;
            return [{ kind: "init", ts, model, sessionId }];
          }
        }
        return [];
      }
      default:
        // session.titleUpdated / checkpoint.created / streamRecovery.updated / telemetry
        return [];
    }
  }

  function reset(): void {
    emittedInit = false;
  }

  return { parseLine, reset };
}

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return createStdoutParser().parseLine(line, ts);
}
