import type { UsageSummary } from "@paperclipai/adapter-utils";

export interface ZcodeStdoutSummary {
  sessionId: string | null;
  response: string | null;
  usage: UsageSummary | undefined;
  modelRef: string | null;
  providerId: string | null;
  modelId: string | null;
  resultJson: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Extract run-level facts from the stream-json stdout of a headless zcode run:
 * the session id, final response, token usage, and the effective model.
 */
export function summarizeStdout(stdout: string): ZcodeStdoutSummary {
  const summary: ZcodeStdoutSummary = {
    sessionId: null,
    response: null,
    usage: undefined,
    modelRef: null,
    providerId: null,
    modelId: null,
    resultJson: null,
  };

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let envelope: unknown;
    try {
      envelope = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(envelope)) continue;

    const sessionId = str(envelope["sessionId"]);
    if (sessionId) summary.sessionId = sessionId;

    const type = str(envelope["type"]);
    const payload = isRecord(envelope["payload"]) ? envelope["payload"] : {};

    if (type === "session.updated" && !summary.modelRef) {
      const model = str(payload["model"]);
      const ref = isRecord(payload["modelRef"]) ? payload["modelRef"] : null;
      if (model) {
        summary.modelRef = model;
        const slash = model.indexOf("/");
        if (slash > 0) {
          summary.providerId = model.slice(0, slash);
          summary.modelId = model.slice(slash + 1);
        }
      } else if (ref) {
        summary.providerId = str(ref["providerId"]);
        summary.modelId = str(ref["modelId"]);
        if (summary.providerId && summary.modelId) {
          summary.modelRef = `${summary.providerId}/${summary.modelId}`;
        }
      }
    }

    if (type === "result") {
      // The final result line carries response/usage at the envelope top level.
      summary.resultJson = envelope;
      summary.response = str(envelope["response"]) ?? summary.response;
      const usage = isRecord(envelope["usage"]) ? envelope["usage"] : null;
      if (usage) {
        const inputTokens = num(usage["inputTokens"]);
        const outputTokens = num(usage["outputTokens"]);
        if (inputTokens !== undefined || outputTokens !== undefined) {
          summary.usage = {
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            cachedInputTokens: num(usage["cacheReadTokens"]),
          };
        }
      }
    }
  }

  return summary;
}

/** Matches "Error: Session not found: sess_..." emitted when --resume points at a dead session. */
export function isUnknownSessionStderr(stderr: string): boolean {
  return /session not found/i.test(stderr);
}

/** First "Error: ..." style line from stderr, for surfacing a readable error message. */
export function firstErrorLine(stderr: string): string | null {
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith("error:")) return trimmed;
  }
  const fallback = stderr.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  return fallback ?? null;
}
