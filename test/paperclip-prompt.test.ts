import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  normalizePaperclipWakePayload,
  renderPaperclipWakePrompt,
} from "../src/server/paperclip-prompt.js";
import { buildPrompt } from "../src/server/execute.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const wakePayload = {
  reason: "comment",
  issue: { id: "iss_1", identifier: "ENG-42", title: "Fix login flow", status: "in_progress", workMode: "build" },
  commentWindow: { requestedCount: 2, includedCount: 2, missingCount: 0 },
  latestCommentId: "c2",
  comments: [
    { id: "c1", body: "Please also cover the timeout path.", author: { type: "user", id: "u_1" }, createdAt: "2026-09-08T10:00:00Z" },
    { id: "c2", body: " regression test needed", author: { type: "agent", id: "a_9" }, createdAt: "2026-09-08T11:00:00Z" },
  ],
  fallbackFetchNeeded: false,
};

describe("renderPaperclipWakePrompt", () => {
  it("renders issue identity, comments and counts", () => {
    const text = renderPaperclipWakePrompt(wakePayload);
    expect(text).toContain("## Paperclip Wake Payload");
    expect(text).toContain("ENG-42 Fix login flow");
    expect(text).toContain("- pending comments: 2/2");
    expect(text).toContain("Please also cover the timeout path.");
    expect(text).toContain("regression test needed");
    expect(text).toContain("- issue status: in_progress");
  });

  it("renders the resume delta header for resumed sessions", () => {
    const text = renderPaperclipWakePrompt(wakePayload, { resumedSession: true });
    expect(text).toContain("## Paperclip Resume Delta");
    expect(text).not.toContain("## Paperclip Wake Payload");
  });

  it("returns empty string for absent payloads", () => {
    expect(normalizePaperclipWakePayload(null)).toBeNull();
    expect(renderPaperclipWakePrompt(undefined)).toBe("");
    expect(renderPaperclipWakePrompt({ random: true })).toBe("");
  });
});

describe("joinPromptSections", () => {
  it("drops empty sections and joins with blank lines", () => {
    expect(joinPromptSections(["a", "", null, undefined, "b"])).toBe("a\n\nb");
  });
});

function makeCtx(overrides: Partial<AdapterExecutionContext>): AdapterExecutionContext {
  return {
    runId: "run_1",
    agent: { id: "agent_1", companyId: "company_1", name: "Zed", adapterType: "zcode_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

describe("buildPrompt", () => {
  it("assembles wake payload, handoff, task markdown and the canonical template", () => {
    const { prompt } = buildPrompt({
      ctx: makeCtx({
        context: {
          paperclipWake: wakePayload,
          paperclipSessionHandoffMarkdown: "Handoff: previous agent left notes.",
          paperclipTaskMarkdown: "Task: fix the login flow.",
        },
      }),
      config: {},
      sessionId: null,
      instructionsFilePath: "",
    });
    expect(prompt).toContain("## Paperclip Wake Payload");
    expect(prompt).toContain("Handoff: previous agent left notes.");
    expect(prompt).toContain("Task: fix the login flow.");
    expect(prompt).toContain("You are agent agent_1 (Zed). Continue your Paperclip work.");
    expect(prompt.indexOf("## Paperclip Wake Payload")).toBeLessThan(prompt.indexOf("You are agent agent_1"));
  });

  it("skips the base template when resuming with a wake delta", () => {
    const { prompt } = buildPrompt({
      ctx: makeCtx({ context: { paperclipWake: wakePayload } }),
      config: {},
      sessionId: "sess_existing",
      instructionsFilePath: "",
    });
    expect(prompt).toContain("## Paperclip Resume Delta");
    expect(prompt).not.toContain("Continue your Paperclip work.");
  });

  it("renders template variables", () => {
    const { prompt } = buildPrompt({
      ctx: makeCtx({}),
      config: { promptTemplate: "Agent {{agent.name}} of {{company.id}} run {{run.id}}" },
      sessionId: null,
      instructionsFilePath: "",
    });
    expect(prompt).toBe("Agent Zed of company_1 run run_1");
  });

  it("appends instructions only on fresh sessions", () => {
    const { prompt } = buildPrompt({
      ctx: makeCtx({}),
      config: {},
      sessionId: null,
      instructionsFilePath: "/nonexistent/instructions.md",
    });
    expect(prompt).not.toContain("instructions");
  });
});

describe("DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE", () => {
  it("references the canonical Paperclip interaction endpoints", () => {
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("{{agent.id}}");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("POST /api/issues/{issueId}/interactions");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("POST /api/issues/{issueId}/comments");
  });
});
