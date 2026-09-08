import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStdoutParser, parseStdoutLine } from "../src/ui-parser.js";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

function parseAll(stdout: string): TranscriptEntry[] {
  const parser = createStdoutParser();
  const entries: TranscriptEntry[] = [];
  for (const line of stdout.split("\n")) {
    entries.push(...parser.parseLine(line, "2026-09-08T12:00:00.000Z"));
  }
  return entries;
}

describe("createStdoutParser against real fixtures", () => {
  it("parses the successful run into a readable transcript", () => {
    const entries = parseAll(loadFixture("run-success.ndjson"));

    const init = entries.find((e) => e.kind === "init");
    expect(init).toMatchObject({
      kind: "init",
      sessionId: "sess_6e44a252-cd21-4a66-90b7-f2410d611c7b",
      model: "builtin:bigmodel-coding-plan/GLM-5.3",
    });

    const user = entries.find((e) => e.kind === "user");
    expect(user?.text).toContain("hello.txt");

    const toolCall = entries.find((e) => e.kind === "tool_call");
    expect(toolCall).toMatchObject({ name: "Write", toolUseId: "call_db14738373db4c4aa026e5b6" });
    expect((toolCall as { input: Record<string, unknown> }).input).toMatchObject({ content: "hi" });

    const toolResult = entries.find((e) => e.kind === "tool_result");
    expect(toolResult).toMatchObject({
      toolUseId: "call_db14738373db4c4aa026e5b6",
      isError: false,
    });
    expect((toolResult as { content: string }).content).toContain("File created successfully");

    const assistant = entries.filter((e) => e.kind === "assistant" && e.delta);
    expect(assistant.map((e) => (e as { text: string }).text).join("")).toContain("done");

    const result = entries.find((e) => e.kind === "result");
    expect(result).toMatchObject({
      kind: "result",
      text: "done",
      inputTokens: 42305,
      outputTokens: 30,
      cachedTokens: 28928,
    });
  });

  it("pairs the tool call and result in the resumed run", () => {
    const entries = parseAll(loadFixture("resume-valid.ndjson"));
    const calls = entries.filter((e) => e.kind === "tool_call");
    const results = entries.filter((e) => e.kind === "tool_result");
    for (const call of calls) {
      const id = (call as { toolUseId?: string }).toolUseId;
      if (id) {
        expect(results.some((r) => r.kind === "tool_result" && r.toolUseId === id)).toBe(true);
      }
    }
    expect(entries.some((e) => e.kind === "assistant")).toBe(true);
  });

  it("emits no transcript entries for telemetry events", () => {
    const entries = parseAll(loadFixture("run-success.ndjson"));
    // hook lifecycle, model_request_*, checkpoints, title updates must not surface
    const texts = entries.map((e) => ("text" in e ? e.text : "")).join("\n");
    expect(texts).not.toContain("hindsight");
    expect(texts).not.toContain("model_request_started");
    expect(entries.filter((e) => e.kind === "stdout")).toHaveLength(0);
  });
});

describe("createStdoutParser edge cases", () => {
  it("returns a stdout entry for non-JSON lines and never throws", () => {
    const parser = createStdoutParser();
    expect(parser.parseLine("plain text noise", "ts")).toEqual([
      { kind: "stdout", ts: "ts", text: "plain text noise" },
    ]);
    expect(parser.parseLine("", "ts")).toEqual([]);
    expect(parser.parseLine(String.fromCharCode(0xff), "ts")).toHaveLength(1);
  });

  it("maps reasoning deltas to thinking entries", () => {
    const line = JSON.stringify({
      type: "model.streaming",
      payload: { kind: "reasoning_delta", delta: "pondering", done: false },
    });
    expect(parseStdoutLine(line, "ts")).toEqual([{ kind: "thinking", ts: "ts", text: "pondering", delta: true }]);
  });

  it("maps tool errors to error results", () => {
    const line = JSON.stringify({
      type: "tool.updated",
      payload: { kind: "error", toolCallId: "call_x", message: "boom" },
    });
    expect(parseStdoutLine(line, "ts")).toEqual([
      { kind: "tool_result", ts: "ts", toolUseId: "call_x", content: "boom", isError: true },
    ]);
  });

  it("skips unknown event types", () => {
    const line = JSON.stringify({ type: "future.event", payload: { whatever: 1 } });
    expect(parseStdoutLine(line, "ts")).toEqual([]);
  });

  it("reset clears the init flag", () => {
    const parser = createStdoutParser();
    const sessionUpdated = JSON.stringify({
      type: "session.updated",
      sessionId: "sess_a",
      payload: { modelRef: { providerId: "p", modelId: "m" } },
    });
    expect(parser.parseLine(sessionUpdated, "ts")[0]?.kind).toBe("init");
    expect(parser.parseLine(sessionUpdated, "ts")).toEqual([]);
    parser.reset();
    expect(parser.parseLine(sessionUpdated, "ts")[0]?.kind).toBe("init");
  });
});
