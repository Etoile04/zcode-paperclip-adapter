import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { firstErrorLine, isUnknownSessionStderr, summarizeStdout } from "../src/server/parse.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

describe("summarizeStdout", () => {
  it("extracts session, response, usage and model from a successful run", () => {
    const summary = summarizeStdout(loadFixture("run-success.ndjson"));
    expect(summary.sessionId).toBe("sess_6e44a252-cd21-4a66-90b7-f2410d611c7b");
    expect(summary.response).toBe("done");
    expect(summary.usage).toEqual({
      inputTokens: 42305,
      outputTokens: 30,
      cachedInputTokens: 28928,
    });
    expect(summary.modelRef).toBe("builtin:bigmodel-coding-plan/GLM-5.3");
    expect(summary.providerId).toBe("builtin:bigmodel-coding-plan");
    expect(summary.modelId).toBe("GLM-5.3");
    expect(summary.resultJson).toMatchObject({ type: "result", response: "done" });
  });

  it("handles empty stdout without throwing", () => {
    const summary = summarizeStdout("");
    expect(summary.sessionId).toBeNull();
    expect(summary.usage).toBeUndefined();
    expect(summary.response).toBeNull();
  });

  it("ignores non-JSON lines", () => {
    const summary = summarizeStdout("not json\n" + JSON.stringify({ type: "result", response: "ok", usage: { inputTokens: 1, outputTokens: 2 } }));
    expect(summary.response).toBe("ok");
    expect(summary.usage).toEqual({ inputTokens: 1, outputTokens: 2, cachedInputTokens: undefined });
  });
});

describe("isUnknownSessionStderr", () => {
  it("matches the real session-not-found error", () => {
    const stderr = loadFixture("resume-invalid.stderr");
    expect(isUnknownSessionStderr(stderr)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isUnknownSessionStderr("Error: Model config is missing")).toBe(false);
    expect(isUnknownSessionStderr("")).toBe(false);
  });
});

describe("firstErrorLine", () => {
  it("returns the first Error: line", () => {
    expect(firstErrorLine("noise\nError: Session not found: sess_x\nError: second")).toBe(
      "Error: Session not found: sess_x",
    );
  });

  it("falls back to the first non-empty line", () => {
    expect(firstErrorLine("plain failure")).toBe("plain failure");
    expect(firstErrorLine("")).toBeNull();
  });
});
