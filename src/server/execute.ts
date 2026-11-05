import {
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  parseObject,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  ADAPTER_TYPE,
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  MIN_TIMEOUT_SEC,
  type ZcodeMode,
} from "../shared/constants.js";
import { resolveZcodeBinary, type ResolvedZcodeBinary } from "./detect-binary.js";
import { firstErrorLine, isUnknownSessionStderr, summarizeStdout } from "./parse.js";
import {
  AdapterConfigError,
  isProtectedEnvName,
  resolveMode,
} from "./security.js";
import { ensureZcodeSkillsSynced, ZCODE_SKILLS_HOME } from "./skills.js";
import {
  applyPaperclipWorkspaceEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "./paperclip-prompt.js";

interface ZcodeSessionParams {
  sessionId?: string;
  cwd?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function splitArgs(extraArgs: string): string[] {
  return extraArgs
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function contextTrimmedString(context: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = context[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function buildChildEnv(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): {
  env: Record<string, string>;
  workspaceContext: Record<string, unknown>;
  /** Protected env names that were dropped from the adapter config. */
  droppedEnvNames: string[];
} {
  const context = ctx.context ?? {};
  const workspaceContext = parseObject(context["paperclipWorkspace"]);

  const envConfig = parseObject(config["env"]);
  const hasExplicitApiKey =
    typeof envConfig["PAPERCLIP_API_KEY"] === "string" && envConfig["PAPERCLIP_API_KEY"].trim().length > 0;

  const env: Record<string, string> = { ...buildPaperclipEnv(ctx.agent) };
  env["PAPERCLIP_RUN_ID"] = ctx.runId;

  const wakeTaskId =
    contextTrimmedString(context, "taskId", "issueId");
  if (wakeTaskId) env["PAPERCLIP_TASK_ID"] = wakeTaskId;
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (issueWorkMode) env["PAPERCLIP_ISSUE_WORK_MODE"] = issueWorkMode;
  const wakeReason = contextTrimmedString(context, "wakeReason");
  if (wakeReason) env["PAPERCLIP_WAKE_REASON"] = wakeReason;
  const wakeCommentId = contextTrimmedString(context, "wakeCommentId", "commentId");
  if (wakeCommentId) env["PAPERCLIP_WAKE_COMMENT_ID"] = wakeCommentId;
  const approvalId = contextTrimmedString(context, "approvalId");
  if (approvalId) env["PAPERCLIP_APPROVAL_ID"] = approvalId;
  const approvalStatus = contextTrimmedString(context, "approvalStatus");
  if (approvalStatus) env["PAPERCLIP_APPROVAL_STATUS"] = approvalStatus;
  const linkedIssueIds = Array.isArray(context["issueIds"])
    ? context["issueIds"].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  if (linkedIssueIds.length > 0) env["PAPERCLIP_LINKED_ISSUE_IDS"] = linkedIssueIds.join(",");
  const wakePayloadJson = stringifyPaperclipWakePayload(context["paperclipWake"]);
  if (wakePayloadJson) env["PAPERCLIP_WAKE_PAYLOAD_JSON"] = wakePayloadJson;

  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: asString(workspaceContext["cwd"], "") || null,
    workspaceSource: asString(workspaceContext["source"], "") || null,
    workspaceStrategy: asString(workspaceContext["strategy"], "") || null,
    workspaceId: asString(workspaceContext["workspaceId"], "") || null,
    workspaceRepoUrl: asString(workspaceContext["repoUrl"], "") || null,
    workspaceRepoRef: asString(workspaceContext["repoRef"], "") || null,
    workspaceBranch: asString(workspaceContext["branchName"], "") || null,
    workspaceWorktreePath: asString(workspaceContext["worktreePath"], "") || null,
    agentHome: asString(workspaceContext["agentHome"], "") || null,
  });

  // Adapter-supplied environment entries may never shadow the variables that
  // decide which binaries and which loader the child process uses — see
  // PROTECTED_ENV_NAMES. Chosen policy: DROP THE OFFENDING ENTRY, keep the
  // rest of the config usable, and report what was dropped (the run's command
  // notes carry the list) so the drop is never silent.
  const droppedEnvNames: string[] = [];

  for (const [name, value] of Object.entries(envConfig)) {
    if (isProtectedEnvName(name)) {
      droppedEnvNames.push(name);
      continue;
    }
    if (typeof value === "string") env[name] = value;
    else if (typeof value === "number" || typeof value === "boolean") env[name] = String(value);
  }
  for (const line of asStringArray(config["envVars"])) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      const name = line.slice(0, eq);
      if (isProtectedEnvName(name)) {
        droppedEnvNames.push(name);
        continue;
      }
      env[name] = line.slice(eq + 1);
    }
  }

  if (!hasExplicitApiKey && ctx.authToken) {
    env["PAPERCLIP_API_KEY"] = ctx.authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  return { env: runtimeEnv, workspaceContext, droppedEnvNames };
}

export function buildPrompt(input: {
  ctx: AdapterExecutionContext;
  config: Record<string, unknown>;
  sessionId: string | null;
  instructionsFilePath: string;
}): { prompt: string; promptMetrics: Record<string, number> } {
  const { ctx, config, sessionId, instructionsFilePath } = input;
  const context = ctx.context ?? {};

  const promptTemplate = asString(config["promptTemplate"], DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const bootstrapPromptTemplate = asString(config["bootstrapPrompt"], "");

  const templateData: Record<string, unknown> = {
    company: { id: ctx.agent.companyId },
    agent: ctx.agent,
    run: { id: ctx.runId, source: "on_demand" },
    context,
  };

  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context["paperclipWake"], { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context["paperclipSessionHandoffMarkdown"], "").trim();
  const taskContextNote = asString(context["paperclipTaskMarkdown"], "").trim();

  let instructions = "";
  if (instructionsFilePath && !sessionId) {
    // On resumed sessions the instructions are already in the session history;
    // re-sending them wastes tokens every heartbeat.
    try {
      instructions = readFileSync(instructionsFilePath, "utf8").trim();
    } catch {
      instructions = "";
    }
  }

  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
    instructions,
  ]);

  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    taskContextChars: taskContextNote.length,
    heartbeatPromptChars: renderedPrompt.length,
    instructionsChars: instructions.length,
  };
  return { prompt, promptMetrics };
}

function failedResult(errorMessage: string, errorCode: string): AdapterExecutionResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorMessage,
    errorCode,
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = ctx.config ?? {};
  const context = ctx.context ?? {};

  const { env, workspaceContext, droppedEnvNames } = buildChildEnv(ctx, config);

  // A configuration value the adapter refuses to act on fails the run loudly
  // (fail-closed). It is never silently ignored, and it never degrades into
  // a different command or a more permissive mode. This runs before any side
  // effect (no directory is created, no process is spawned) for a rejected
  // configuration.
  let binary: ResolvedZcodeBinary | null = null;
  let mode: ZcodeMode;
  try {
    binary = resolveZcodeBinary(asString(config["zcodeCommand"], "") || undefined, process.env);
    mode = resolveMode(config["mode"]);
  } catch (error) {
    if (error instanceof AdapterConfigError) {
      return failedResult(
        `zcode adapter configuration rejected: ${error.message}`,
        "invalid_adapter_config",
      );
    }
    throw error;
  }
  const command = binary?.command ?? "zcode";
  const baseArgs = binary?.args ?? [];

  const workspaceSource = asString(workspaceContext["source"], "");
  const workspaceCwd = asString(workspaceContext["cwd"], "");
  const configuredCwd = asString(config["cwd"], "");
  // A user-configured cwd wins when the workspace is just the agent home dir.
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = path.resolve(effectiveWorkspaceCwd || configuredCwd || process.cwd());
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  } catch {
    // runChildProcess will surface the spawn error if the directory is unusable.
  }

  const timeoutSec = clamp(
    asNumber(config["timeoutSec"], DEFAULT_TIMEOUT_SEC),
    MIN_TIMEOUT_SEC,
    MAX_TIMEOUT_SEC,
  );
  const graceSec = clamp(asNumber(config["graceSec"], 15), 5, 60);
  const persistSession = config["persistSession"] === undefined ? true : asBoolean(config["persistSession"], true);
  const disallowedTools = asStringArray(config["disallowedTools"]);
  const extraArgs = asStringArray(config["extraArgs"]).length > 0
    ? asStringArray(config["extraArgs"])
    : splitArgs(asString(config["args"], ""));
  const instructionsFilePath = asString(config["instructionsFilePath"], "").trim();
  const maxTurns = asNumber(config["maxTurnsPerRun"], 0);

  const prior = parseObject(ctx.runtime.sessionParams) as Partial<ZcodeSessionParams>;
  // Legacy fallback: hosts that only persist runtime.sessionId (no params) still get resume.
  const legacySessionId =
    typeof ctx.runtime.sessionId === "string" && ctx.runtime.sessionId.trim().length > 0
      ? ctx.runtime.sessionId.trim()
      : null;
  const priorSessionId =
    (typeof prior.sessionId === "string" && prior.sessionId.trim().length > 0 ? prior.sessionId.trim() : null) ??
    legacySessionId;
  const priorCwd = typeof prior.cwd === "string" && prior.cwd.trim().length > 0 ? prior.cwd : null;
  // Resume unless we positively know the session belongs to a different cwd.
  const canResume =
    persistSession && priorSessionId !== null && (priorCwd === null || path.resolve(priorCwd) === cwd);

  const commandNotes: string[] = [];
  // Self-healing skill sync: make desired Paperclip skills visible to zcode
  // (~/.agents/skills symlinks) even if the host never called syncSkills.
  try {
    const before = readdirSync(ZCODE_SKILLS_HOME).length;
    for (const warning of await ensureZcodeSkillsSynced(config)) {
      commandNotes.push(warning);
    }
    const after = readdirSync(ZCODE_SKILLS_HOME).length;
    commandNotes.push(
      `skills sync: ${(Array.isArray(config["paperclipRuntimeSkills"]) ? config["paperclipRuntimeSkills"].length : 0)} sources offered, desired=${JSON.stringify(config["paperclipSkillSync"] ?? null)} ~/.agents/skills ${before}->${after}`,
    );
  } catch {
    // Skill injection is best-effort; the run proceeds without it.
  }
  if (binary) commandNotes.push(`binary resolved from ${binary.source}`);
  else commandNotes.push("no explicit zcode binary found; falling back to `zcode` on PATH");
  if (droppedEnvNames.length > 0) {
    commandNotes.push(
      `dropped protected env entries from adapter config (not overridable): ${[...new Set(droppedEnvNames)].join(", ")}`,
    );
  }
  if (maxTurns > 0) {
    commandNotes.push(`maxTurnsPerRun=${maxTurns} requested but the zcode CLI has no --max-turns support; only the ${timeoutSec}s timeout applies.`);
  }
  if (!persistSession) commandNotes.push("session persistence disabled (persistSession=false)");
  else if (!canResume && priorSessionId) commandNotes.push("prior session cwd differs; starting a fresh session");

  const { prompt, promptMetrics } = buildPrompt({
    ctx,
    config,
    sessionId: canResume ? priorSessionId : null,
    instructionsFilePath,
  });

  const buildArgs = (resume: boolean): string[] => [
    ...baseArgs,
    "--prompt",
    prompt,
    "--output-format",
    "stream-json",
    "--mode",
    mode,
    "--cwd",
    cwd,
    ...(resume && priorSessionId ? ["--resume", priorSessionId] : []),
    ...(disallowedTools.length > 0 ? ["--disallowed-tools", disallowedTools.join(",")] : []),
    ...extraArgs,
  ];

  try {
    await ctx.onMeta?.({
      adapterType: ADAPTER_TYPE,
      command,
      commandArgs: buildArgs(canResume).filter((arg) => arg !== prompt),
      cwd,
      commandNotes,
      prompt,
      context,
    });
  } catch {
    // Metadata emission is best-effort.
  }

  const runOnce = (resume: boolean) =>
    runChildProcess(ctx.runId, command, buildArgs(resume), {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog: ctx.onLog,
    });

  let clearSession = false;
  let proc = await runOnce(canResume);

  if (proc.exitCode !== 0 && canResume && isUnknownSessionStderr(proc.stderr)) {
    clearSession = true;
    commandNotes.push("prior session no longer resumable; retried without --resume");
    proc = await runOnce(false);
  }

  const summary = summarizeStdout(proc.stdout);

  let errorMessage: string | null = null;
  let errorCode: string | null = null;
  if (proc.timedOut) {
    errorMessage = `zcode run timed out after ${timeoutSec}s`;
    errorCode = "timeout";
  } else if (proc.exitCode !== 0) {
    errorMessage =
      firstErrorLine(proc.stderr) ?? `zcode exited with code ${proc.exitCode ?? "null"} (signal ${proc.signal ?? "none"})`;
    errorCode = clearSession ? "unknown_session" : "zcode_error";
  }

  const sessionId = summary.sessionId;
  const sessionParams = persistSession && sessionId ? { sessionId, cwd } : null;
  const sessionDisplayId = sessionId ? sessionId.replace(/^sess_/, "").slice(0, 12) : null;

  const billingType =
    summary.providerId?.includes("coding-plan") || summary.providerId?.includes("start-plan")
      ? ("subscription" as const)
      : ("api" as const);

  const result: AdapterExecutionResult = {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage,
    errorCode,
    usage: summary.usage,
    sessionId: sessionId ?? null,
    sessionParams,
    sessionDisplayId,
    provider: summary.providerId,
    model: summary.modelId,
    billingType,
    resultJson: summary.resultJson,
    summary: summary.response ? summary.response.trim().slice(0, 400) : null,
  };
  if (clearSession) result.clearSession = true;
  return result;
}

export { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE };
