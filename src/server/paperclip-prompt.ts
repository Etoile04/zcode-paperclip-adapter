/**
 * Vendored Paperclip prompt helpers.
 *
 * Copied from paperclipai/paperclip `packages/adapter-utils/src/server-utils.ts`
 * (MIT licensed) because the npm-published @paperclipai/adapter-utils 0.3.1
 * does not yet export them. When a published adapter-utils version includes
 * DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE / renderPaperclipWakePrompt /
 * joinPromptSections, this file can be replaced by direct imports.
 */
import { asBoolean, asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export const DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE = [
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  "",
  "Execution contract:",
  "- Start actionable work in this heartbeat; do not stop at a plan unless the issue asks for planning.",
  "- Leave durable progress in comments, documents, or work products, then update the issue to a clear final disposition before ending the heartbeat.",
  "- Comments, documents, screenshots, work products, and `Remaining` bullets are evidence, not valid liveness paths by themselves.",
  "- Final disposition checklist: mark `done` when complete; use `in_review` only with a real reviewer, approval, interaction, or monitor path; use `blocked` only with first-class blockers or a named unblock owner/action; create delegated follow-up issues with blockers when another agent owns the next step; keep `in_progress` only when a live continuation path exists.",
  "- Prefer the smallest verification that proves the change; do not default to full workspace typecheck/build/test on every heartbeat unless the task scope warrants it.",
  "- Use child issues for parallel or long delegated work instead of polling agents, sessions, or processes.",
  "- If woken by a human comment on a dependency-blocked issue, respond or triage the comment without treating the blocked deliverable work as unblocked.",
  "- Create child issues directly when you know what needs to be done; use issue-thread interactions when the board/user must choose suggested tasks, answer structured questions, or confirm a proposal.",
  "- To ask for that input, create an interaction on the current issue with POST /api/issues/{issueId}/interactions using kind suggest_tasks, ask_user_questions, or request_confirmation. Use continuationPolicy wake_assignee when you need to resume after a response; for request_confirmation this resumes only after acceptance.",
  "- When you intentionally restart follow-up work on a completed assigned issue, include structured `resume: true` with the POST /api/issues/{issueId}/comments or PATCH /api/issues/{issueId} comment payload. Generic agent comments on closed issues are inert by default.",
  "- For plan approval, update the plan document first, then create request_confirmation targeting the latest plan revision with idempotencyKey confirmation:{issueId}:plan:{revisionId}. Wait for acceptance before creating implementation subtasks, and create a fresh confirmation after superseding board/user comments if approval is still needed.",
  "- If blocked, mark the issue blocked and name the unblock owner and action.",
  "- Respect budget, pause/cancel, approval gates, and company boundaries.",
].join("\n");

const WATCHDOG_DEFAULT_MANDATE = [
  "You are running as a task watchdog, not as the original deliverable worker.",
  "Your mission is to keep the watched issue tree moving by verifying stopped work, not by trusting agent claims.",
  "",
  "Mandate:",
  "- Treat every terminal, cancelled, blocked, in-review, or otherwise stopped leaf in the watched subtree as a claim that must be verified against comments, documents, work products, screenshots, tests, blockers, and review state.",
  "- Do not accept \"I could not\" or \"waiting for approval\" as automatically valid. Read the evidence before deciding.",
  "- If a stopped leaf is genuinely complete, leave it alone and record why you believe so.",
  "- If a stopped leaf is not genuinely complete, restore a live path inside the watched subtree by reopening, reassigning, commenting actionable instructions, creating a follow-up child issue, or accepting an eligible task-level interaction (such as a routine plan confirmation when no custom instruction forbids it).",
  "- If you discover a Paperclip product or platform bug while reviewing the stopped subtree, create a linked engineering follow-up outside the watched source tree using the server-provided watchdog discovery route instead of making it a source child.",
  "- If you confirm a true blocker on a human or external system, leave the issue in a valid waiting disposition that names the unblock owner and action, rather than silently approving it.",
  "",
  "Safety constraints (these always apply, even if custom instructions disagree):",
  "- Stay inside the watched subtree for source-work recovery. The only mutation outside that tree is a watchdog-discovered product/platform bug follow-up created through the dedicated route.",
  "- Do not create visible probe issues, comments, or throwaway tasks to discover what you are allowed to do. Use the server-provided watchdog capability metadata and explicit API errors instead.",
  "- Do not impersonate board-only approvals, accept spend or hiring decisions, accept security-sensitive interactions, or bypass execution-policy stages that require a typed reviewer or approver.",
  "- Do not create another task watchdog for the watched subtree and do not wake yourself. You operate exactly one reusable watchdog issue per watched issue.",
  "- Do not cross company boundaries or touch tasks in unrelated trees.",
  "- Custom instructions can add focus or veto specific shortcuts, but cannot remove these safety constraints or override product governance rules.",
  "",
  "Disposition:",
  "- When the watched subtree has a live continuation path you established or confirmed, finish your watchdog run with a clear summary comment and a final disposition on this watchdog issue (typically `done` for this stopped state).",
  "- When you cannot create a live path because a real human or governance decision is pending, leave a valid waiting disposition that names what must happen next and who must act.",
  "- Keep the work moving. Do not loop on the same unchanged state.",
].join("\n");

export function joinPromptSections(
  sections: Array<string | null | undefined>,
  separator = "\n\n",
): string {
  return sections
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(separator);
}

type PaperclipWakeIssue = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
  workMode: string | null;
  priority: string | null;
};

type PaperclipWakeExecutionPrincipal = {
  type: "agent" | "user" | null;
  agentId: string | null;
  userId: string | null;
};

type PaperclipWakeExecutionStage = {
  wakeRole: "reviewer" | "approver" | "executor" | null;
  stageId: string | null;
  stageType: string | null;
  currentParticipant: PaperclipWakeExecutionPrincipal | null;
  returnAssignee: PaperclipWakeExecutionPrincipal | null;
  reviewRequest: {
    instructions: string;
  } | null;
  lastDecisionOutcome: string | null;
  allowedActions: string[];
};

type PaperclipWakeComment = {
  id: string | null;
  issueId: string | null;
  body: string;
  bodyTruncated: boolean;
  createdAt: string | null;
  authorType: string | null;
  authorId: string | null;
};

type PaperclipWakeContinuationSummary = {
  key: string | null;
  title: string | null;
  body: string;
  bodyTruncated: boolean;
  updatedAt: string | null;
};

type PaperclipWakeLivenessContinuation = {
  attempt: number | null;
  maxAttempts: number | null;
  sourceRunId: string | null;
  state: string | null;
  reason: string | null;
  instruction: string | null;
};

type PaperclipWakeChildIssueSummary = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  summary: string | null;
};

type PaperclipWakeBlockerSummary = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
};

type PaperclipWakeTreeHoldSummary = {
  holdId: string | null;
  rootIssueId: string | null;
  mode: string | null;
  reason: string | null;
};

type PaperclipWakeTaskWatchdogLeaf = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  role: string | null;
  summary: string | null;
};

type PaperclipWakeTaskWatchdogCapabilities = {
  operations: string[];
  deniedOperations: string[];
  targetScope: {
    watchedIssueId: string | null;
    watchedIssueIdentifier: string | null;
    watchdogIssueId: string | null;
    includeNonWatchdogDescendants: boolean;
    excludedOriginKinds: string[];
  } | null;
};

type PaperclipWakeTaskWatchdogContext = {
  watchedIssueId: string | null;
  watchedIssueIdentifier: string | null;
  watchedIssueTitle: string | null;
  stopFingerprint: string | null;
  terminalLeafSummaries: PaperclipWakeTaskWatchdogLeaf[];
  customInstructions: string | null;
  capabilities: PaperclipWakeTaskWatchdogCapabilities | null;
};

type PaperclipWakePayload = {
  reason: string | null;
  issue: PaperclipWakeIssue | null;
  checkedOutByHarness: boolean;
  dependencyBlockedInteraction: boolean;
  treeHoldInteraction: boolean;
  activeTreeHold: PaperclipWakeTreeHoldSummary | null;
  unresolvedBlockerIssueIds: string[];
  unresolvedBlockerSummaries: PaperclipWakeBlockerSummary[];
  executionStage: PaperclipWakeExecutionStage | null;
  continuationSummary: PaperclipWakeContinuationSummary | null;
  livenessContinuation: PaperclipWakeLivenessContinuation | null;
  taskWatchdog: PaperclipWakeTaskWatchdogContext | null;
  interactionKind: string | null;
  interactionStatus: string | null;
  childIssueSummaries: PaperclipWakeChildIssueSummary[];
  childIssueSummaryTruncated: boolean;
  commentIds: string[];
  latestCommentId: string | null;
  comments: PaperclipWakeComment[];
  requestedCount: number;
  includedCount: number;
  missingCount: number;
  truncated: boolean;
  fallbackFetchNeeded: boolean;
};

function normalizePaperclipWakeIssue(value: unknown): PaperclipWakeIssue | null {
  const issue = parseObject(value);
  const id = asString(issue["id"], "").trim() || null;
  const identifier = asString(issue["identifier"], "").trim() || null;
  const title = asString(issue["title"], "").trim() || null;
  const status = asString(issue["status"], "").trim() || null;
  const workMode = asString(issue["workMode"], "").trim() || null;
  const priority = asString(issue["priority"], "").trim() || null;
  if (!id && !identifier && !title) return null;
  return { id, identifier, title, status, workMode, priority };
}

function normalizePaperclipWakeComment(value: unknown): PaperclipWakeComment | null {
  const comment = parseObject(value);
  const author = parseObject(comment["author"]);
  const body = asString(comment["body"], "");
  if (!body.trim()) return null;
  return {
    id: asString(comment["id"], "").trim() || null,
    issueId: asString(comment["issueId"], "").trim() || null,
    body,
    bodyTruncated: asBoolean(comment["bodyTruncated"], false),
    createdAt: asString(comment["createdAt"], "").trim() || null,
    authorType: asString(author["type"], "").trim() || null,
    authorId: asString(author["id"], "").trim() || null,
  };
}

function normalizePaperclipWakeContinuationSummary(value: unknown): PaperclipWakeContinuationSummary | null {
  const summary = parseObject(value);
  const body = asString(summary["body"], "").trim();
  if (!body) return null;
  return {
    key: asString(summary["key"], "").trim() || null,
    title: asString(summary["title"], "").trim() || null,
    body,
    bodyTruncated: asBoolean(summary["bodyTruncated"], false),
    updatedAt: asString(summary["updatedAt"], "").trim() || null,
  };
}

function normalizePaperclipWakeLivenessContinuation(value: unknown): PaperclipWakeLivenessContinuation | null {
  const continuation = parseObject(value);
  const attempt = asNumber(continuation["attempt"], 0);
  const maxAttempts = asNumber(continuation["maxAttempts"], 0);
  const sourceRunId = asString(continuation["sourceRunId"], "").trim() || null;
  const state = asString(continuation["state"], "").trim() || null;
  const reason = asString(continuation["reason"], "").trim() || null;
  const instruction = asString(continuation["instruction"], "").trim() || null;
  if (!attempt && !maxAttempts && !sourceRunId && !state && !reason && !instruction) return null;
  return {
    attempt: attempt > 0 ? attempt : null,
    maxAttempts: maxAttempts > 0 ? maxAttempts : null,
    sourceRunId,
    state,
    reason,
    instruction,
  };
}

function normalizePaperclipWakeChildIssueSummary(value: unknown): PaperclipWakeChildIssueSummary | null {
  const child = parseObject(value);
  const id = asString(child["id"], "").trim() || null;
  const identifier = asString(child["identifier"], "").trim() || null;
  const title = asString(child["title"], "").trim() || null;
  const status = asString(child["status"], "").trim() || null;
  const priority = asString(child["priority"], "").trim() || null;
  const summary = asString(child["summary"], "").trim() || null;
  if (!id && !identifier && !title && !status && !summary) return null;
  return { id, identifier, title, status, priority, summary };
}

function normalizePaperclipWakeBlockerSummary(value: unknown): PaperclipWakeBlockerSummary | null {
  const blocker = parseObject(value);
  const id = asString(blocker["id"], "").trim() || null;
  const identifier = asString(blocker["identifier"], "").trim() || null;
  const title = asString(blocker["title"], "").trim() || null;
  const status = asString(blocker["status"], "").trim() || null;
  const priority = asString(blocker["priority"], "").trim() || null;
  if (!id && !identifier && !title && !status) return null;
  return { id, identifier, title, status, priority };
}

function normalizePaperclipWakeTreeHoldSummary(value: unknown): PaperclipWakeTreeHoldSummary | null {
  const hold = parseObject(value);
  const holdId = asString(hold["holdId"], "").trim() || null;
  const rootIssueId = asString(hold["rootIssueId"], "").trim() || null;
  const mode = asString(hold["mode"], "").trim() || null;
  const reason = asString(hold["reason"], "").trim() || null;
  if (!holdId && !rootIssueId && !mode && !reason) return null;
  return { holdId, rootIssueId, mode, reason };
}

function normalizePaperclipWakeExecutionPrincipal(value: unknown): PaperclipWakeExecutionPrincipal | null {
  const principal = parseObject(value);
  const typeRaw = asString(principal["type"], "").trim().toLowerCase();
  if (typeRaw !== "agent" && typeRaw !== "user") return null;
  return {
    type: typeRaw,
    agentId: asString(principal["agentId"], "").trim() || null,
    userId: asString(principal["userId"], "").trim() || null,
  };
}

const MAX_WATCHDOG_INSTRUCTIONS_CHARS = 4_000;
const MAX_WATCHDOG_LEAF_SUMMARIES = 25;
const MAX_WATCHDOG_CAPABILITY_ITEMS = 50;

function normalizePaperclipWakeTaskWatchdogLeaf(value: unknown): PaperclipWakeTaskWatchdogLeaf | null {
  const leaf = parseObject(value);
  const id = asString(leaf["id"], "").trim() || null;
  const identifier = asString(leaf["identifier"], "").trim() || null;
  const title = asString(leaf["title"], "").trim() || null;
  const status = asString(leaf["status"], "").trim() || null;
  const priority = asString(leaf["priority"], "").trim() || null;
  const role = asString(leaf["role"], "").trim() || null;
  const summary = asString(leaf["summary"], "").trim() || null;
  if (!id && !identifier && !title && !status && !summary) return null;
  return { id, identifier, title, status, priority, role, summary };
}

function normalizeStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, maxItems);
}

function normalizePaperclipWakeTaskWatchdogCapabilities(value: unknown): PaperclipWakeTaskWatchdogCapabilities | null {
  const capabilities = parseObject(value);
  const operations = normalizeStringList(capabilities["operations"], MAX_WATCHDOG_CAPABILITY_ITEMS);
  const deniedOperations = normalizeStringList(capabilities["deniedOperations"], MAX_WATCHDOG_CAPABILITY_ITEMS);
  const targetScopeRaw = parseObject(capabilities["targetScope"]);
  const targetScope = {
    watchedIssueId: asString(targetScopeRaw["watchedIssueId"], "").trim() || null,
    watchedIssueIdentifier: asString(targetScopeRaw["watchedIssueIdentifier"], "").trim() || null,
    watchdogIssueId: asString(targetScopeRaw["watchdogIssueId"], "").trim() || null,
    includeNonWatchdogDescendants: asBoolean(targetScopeRaw["includeNonWatchdogDescendants"], false),
    excludedOriginKinds: normalizeStringList(targetScopeRaw["excludedOriginKinds"], MAX_WATCHDOG_CAPABILITY_ITEMS),
  };
  const hasTargetScope = Boolean(
    targetScope.watchedIssueId ||
      targetScope.watchedIssueIdentifier ||
      targetScope.watchdogIssueId ||
      targetScope.includeNonWatchdogDescendants ||
      targetScope.excludedOriginKinds.length > 0,
  );
  if (operations.length === 0 && deniedOperations.length === 0 && !hasTargetScope) return null;
  return {
    operations,
    deniedOperations,
    targetScope: hasTargetScope ? targetScope : null,
  };
}

function normalizePaperclipWakeTaskWatchdog(value: unknown): PaperclipWakeTaskWatchdogContext | null {
  const watchdog = parseObject(value);
  const watchedIssueId = asString(watchdog["watchedIssueId"], "").trim() || null;
  const watchedIssueIdentifier = asString(watchdog["watchedIssueIdentifier"], "").trim() || null;
  const watchedIssueTitle = asString(watchdog["watchedIssueTitle"], "").trim() || null;
  const stopFingerprint = asString(watchdog["stopFingerprint"], "").trim() || null;
  const customInstructionsRaw = asString(watchdog["customInstructions"], "");
  const customInstructionsTrimmed = customInstructionsRaw.trim();
  const customInstructions = customInstructionsTrimmed
    ? customInstructionsTrimmed.length > MAX_WATCHDOG_INSTRUCTIONS_CHARS
      ? customInstructionsTrimmed.slice(0, MAX_WATCHDOG_INSTRUCTIONS_CHARS)
      : customInstructionsTrimmed
    : null;
  const terminalLeafSummaries = Array.isArray(watchdog["terminalLeafSummaries"])
    ? watchdog["terminalLeafSummaries"]
        .slice(0, MAX_WATCHDOG_LEAF_SUMMARIES)
        .map((entry) => normalizePaperclipWakeTaskWatchdogLeaf(entry))
        .filter((entry): entry is PaperclipWakeTaskWatchdogLeaf => Boolean(entry))
    : [];
  const capabilities = normalizePaperclipWakeTaskWatchdogCapabilities(watchdog["capabilities"]);

  if (
    !watchedIssueId &&
    !watchedIssueIdentifier &&
    !watchedIssueTitle &&
    !stopFingerprint &&
    !customInstructions &&
    terminalLeafSummaries.length === 0 &&
    !capabilities
  ) {
    return null;
  }

  return {
    watchedIssueId,
    watchedIssueIdentifier,
    watchedIssueTitle,
    stopFingerprint,
    terminalLeafSummaries,
    customInstructions,
    capabilities,
  };
}

function normalizePaperclipWakeExecutionStage(value: unknown): PaperclipWakeExecutionStage | null {
  const stage = parseObject(value);
  const wakeRoleRaw = asString(stage["wakeRole"], "").trim().toLowerCase();
  const wakeRole =
    wakeRoleRaw === "reviewer" || wakeRoleRaw === "approver" || wakeRoleRaw === "executor"
      ? wakeRoleRaw
      : null;
  const allowedActions = Array.isArray(stage["allowedActions"])
    ? stage["allowedActions"]
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  const currentParticipant = normalizePaperclipWakeExecutionPrincipal(stage["currentParticipant"]);
  const returnAssignee = normalizePaperclipWakeExecutionPrincipal(stage["returnAssignee"]);
  const reviewRequestRaw = parseObject(stage["reviewRequest"]);
  const reviewInstructions = asString(reviewRequestRaw["instructions"], "").trim();
  const reviewRequest = reviewInstructions ? { instructions: reviewInstructions } : null;
  const stageId = asString(stage["stageId"], "").trim() || null;
  const stageType = asString(stage["stageType"], "").trim() || null;
  const lastDecisionOutcome = asString(stage["lastDecisionOutcome"], "").trim() || null;

  if (!wakeRole && !stageId && !stageType && !currentParticipant && !returnAssignee && !reviewRequest && !lastDecisionOutcome && allowedActions.length === 0) {
    return null;
  }

  return {
    wakeRole,
    stageId,
    stageType,
    currentParticipant,
    returnAssignee,
    reviewRequest,
    lastDecisionOutcome,
    allowedActions,
  };
}

export function normalizePaperclipWakePayload(value: unknown): PaperclipWakePayload | null {
  const payload = parseObject(value);
  const comments = Array.isArray(payload["comments"])
    ? payload["comments"]
        .map((entry) => normalizePaperclipWakeComment(entry))
        .filter((entry): entry is PaperclipWakeComment => Boolean(entry))
    : [];
  const commentWindow = parseObject(payload["commentWindow"]);
  const commentIds = Array.isArray(payload["commentIds"])
    ? payload["commentIds"]
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  const executionStage = normalizePaperclipWakeExecutionStage(payload["executionStage"]);
  const continuationSummary = normalizePaperclipWakeContinuationSummary(payload["continuationSummary"]);
  const livenessContinuation = normalizePaperclipWakeLivenessContinuation(payload["livenessContinuation"]);
  const taskWatchdog = normalizePaperclipWakeTaskWatchdog(payload["taskWatchdog"]);
  const childIssueSummaries = Array.isArray(payload["childIssueSummaries"])
    ? payload["childIssueSummaries"]
        .map((entry) => normalizePaperclipWakeChildIssueSummary(entry))
        .filter((entry): entry is PaperclipWakeChildIssueSummary => Boolean(entry))
    : [];
  const unresolvedBlockerIssueIds = Array.isArray(payload["unresolvedBlockerIssueIds"])
    ? payload["unresolvedBlockerIssueIds"]
        .map((entry) => asString(entry, "").trim())
        .filter(Boolean)
    : [];
  const unresolvedBlockerSummaries = Array.isArray(payload["unresolvedBlockerSummaries"])
    ? payload["unresolvedBlockerSummaries"]
        .map((entry) => normalizePaperclipWakeBlockerSummary(entry))
        .filter((entry): entry is PaperclipWakeBlockerSummary => Boolean(entry))
    : [];

  const activeTreeHold = normalizePaperclipWakeTreeHoldSummary(payload["activeTreeHold"]);
  if (comments.length === 0 && commentIds.length === 0 && childIssueSummaries.length === 0 && unresolvedBlockerIssueIds.length === 0 && unresolvedBlockerSummaries.length === 0 && !activeTreeHold && !executionStage && !continuationSummary && !livenessContinuation && !taskWatchdog && !normalizePaperclipWakeIssue(payload["issue"])) {
    return null;
  }

  return {
    reason: asString(payload["reason"], "").trim() || null,
    issue: normalizePaperclipWakeIssue(payload["issue"]),
    checkedOutByHarness: asBoolean(payload["checkedOutByHarness"], false),
    dependencyBlockedInteraction: asBoolean(payload["dependencyBlockedInteraction"], false),
    treeHoldInteraction: asBoolean(payload["treeHoldInteraction"], false),
    activeTreeHold,
    unresolvedBlockerIssueIds,
    unresolvedBlockerSummaries,
    executionStage,
    continuationSummary,
    livenessContinuation,
    taskWatchdog,
    interactionKind: asString(payload["interactionKind"], "").trim() || null,
    interactionStatus: asString(payload["interactionStatus"], "").trim() || null,
    childIssueSummaries,
    childIssueSummaryTruncated: asBoolean(payload["childIssueSummaryTruncated"], false),
    commentIds,
    latestCommentId: asString(payload["latestCommentId"], "").trim() || null,
    comments,
    requestedCount: asNumber(commentWindow["requestedCount"], comments.length || commentIds.length),
    includedCount: asNumber(commentWindow["includedCount"], comments.length),
    missingCount: asNumber(commentWindow["missingCount"], 0),
    truncated: asBoolean(payload["truncated"], false),
    fallbackFetchNeeded: asBoolean(payload["fallbackFetchNeeded"], false),
  };
}

export function stringifyPaperclipWakePayload(value: unknown): string | null {
  const normalized = normalizePaperclipWakePayload(value);
  if (!normalized) return null;
  return JSON.stringify(normalized);
}

export function readPaperclipIssueWorkModeFromContext(value: unknown): string | null {
  const context = parseObject(value);
  const issue = parseObject(context["paperclipIssue"]);
  const direct = asString(issue["workMode"], "").trim();
  if (direct) return direct;
  const wake = normalizePaperclipWakePayload(context["paperclipWake"]);
  return wake?.issue?.workMode ?? null;
}

export function renderPaperclipWakePrompt(
  value: unknown,
  options: { resumedSession?: boolean } = {},
): string {
  const normalized = normalizePaperclipWakePayload(value);
  if (!normalized) return "";
  const resumedSession = options.resumedSession === true;
  const executionStage = normalized.executionStage;
  const principalLabel = (principal: PaperclipWakeExecutionPrincipal | null) => {
    if (!principal || !principal.type) return "unknown";
    if (principal.type === "agent") return principal.agentId ? `agent ${principal.agentId}` : "agent";
    return principal.userId ? `user ${principal.userId}` : "user";
  };

  const lines = resumedSession
    ? [
        "## Paperclip Resume Delta",
        "",
        "You are resuming an existing Paperclip session.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "Focus on the new wake delta below and continue the current task without restating the full heartbeat boilerplate.",
        "Fetch the API thread only when `fallbackFetchNeeded` is true or you need broader history than this batch.",
        "",
        "Execution contract: take concrete action in this heartbeat when the issue is actionable; do not stop at a plan unless planning was requested. Leave durable progress and then give the issue a clear final disposition before ending the heartbeat: `done`, `in_review` with a real reviewer/approval/interaction path, `blocked` with first-class blockers or a named unblock owner/action, delegated follow-up issues with blockers, or `in_progress` only when a live continuation path exists. Use child issues for long or parallel delegated work instead of polling. Comments, documents, screenshots, work products, and `Remaining` bullets are evidence, not valid liveness paths by themselves.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ]
    : [
        "## Paperclip Wake Payload",
        "",
        "Treat this wake payload as the highest-priority change for the current heartbeat.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "Before generic repo exploration or boilerplate heartbeat updates, acknowledge the latest comment and explain how it changes your next action.",
        "Use this inline wake data first before refetching the issue thread.",
        "Only fetch the API thread when `fallbackFetchNeeded` is true or you need broader history than this batch.",
        "",
        "Execution contract: take concrete action in this heartbeat when the issue is actionable; do not stop at a plan unless planning was requested. Leave durable progress and then give the issue a clear final disposition before ending the heartbeat: `done`, `in_review` with a real reviewer/approval/interaction path, `blocked` with first-class blockers or a named unblock owner/action, delegated follow-up issues with blockers, or `in_progress` only when a live continuation path exists. Use child issues for long or parallel delegated work instead of polling. Comments, documents, screenshots, work products, and `Remaining` bullets are evidence, not valid liveness paths by themselves.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ];

  if (normalized.issue?.status) {
    lines.push(`- issue status: ${normalized.issue.status}`);
  }
  if (normalized.issue?.workMode) {
    lines.push(`- issue work mode: ${normalized.issue.workMode}`);
  }
  if (normalized.issue?.priority) {
    lines.push(`- issue priority: ${normalized.issue.priority}`);
  }
  if (normalized.issue?.workMode === "planning" && !normalized.taskWatchdog) {
    const hasWakeComments = normalized.comments.length > 0;
    const acceptedPlanContinuation =
      !hasWakeComments &&
      normalized.interactionKind === "request_confirmation" && normalized.interactionStatus === "accepted";
    let directive = "Make the plan only. Do not write code or perform implementation work.";
    if (hasWakeComments) {
      directive = "Update the plan only. Do not write code or perform implementation work.";
    }
    if (acceptedPlanContinuation) {
      directive = "Create child issues from the approved plan only. Do not write code or perform implementation work on the planning issue.";
    }
    lines.push(`- planning directive: ${directive}`);
    if (acceptedPlanContinuation) {
      lines.push(
        "- accepted-plan continuation: you may create child implementation issues from the approved plan, but must not start implementation work on the planning issue itself",
      );
    }
  }
  if (normalized.checkedOutByHarness) {
    lines.push("- checkout: already claimed by the harness for this run");
  }
  if (normalized.dependencyBlockedInteraction) {
    lines.push("- dependency-blocked interaction: yes");
    lines.push("- execution scope: respond or triage the human comment; do not treat blocker-dependent deliverable work as unblocked");
    if (normalized.unresolvedBlockerSummaries.length > 0) {
      const blockers = normalized.unresolvedBlockerSummaries
        .map((blocker) => `${blocker.identifier ?? blocker.id ?? "unknown"}${blocker.title ? ` ${blocker.title}` : ""}${blocker.status ? ` (${blocker.status})` : ""}`)
        .join("; ");
      lines.push(`- unresolved blockers: ${blockers}`);
    } else if (normalized.unresolvedBlockerIssueIds.length > 0) {
      lines.push(`- unresolved blocker issue ids: ${normalized.unresolvedBlockerIssueIds.join(", ")}`);
    }
  }
  if (normalized.treeHoldInteraction) {
    lines.push("- tree-hold interaction: yes");
    lines.push("- execution scope: respond or triage the human comment; the subtree remains paused until an explicit resume action");
    if (normalized.activeTreeHold) {
      const hold = normalized.activeTreeHold;
      lines.push(`- active tree hold: ${hold.holdId ?? "unknown"}${hold.rootIssueId ? ` rooted at ${hold.rootIssueId}` : ""}${hold.mode ? ` (${hold.mode})` : ""}`);
    }
  }
  if (normalized.missingCount > 0) {
    lines.push(`- omitted comments: ${normalized.missingCount}`);
  }

  if (executionStage) {
    lines.push(
      `- execution wake role: ${executionStage.wakeRole ?? "unknown"}`,
      `- execution stage: ${executionStage.stageType ?? "unknown"}`,
      `- execution participant: ${principalLabel(executionStage.currentParticipant)}`,
      `- execution return assignee: ${principalLabel(executionStage.returnAssignee)}`,
      `- last decision outcome: ${executionStage.lastDecisionOutcome ?? "none"}`,
    );
    if (executionStage.allowedActions.length > 0) {
      lines.push(`- allowed actions: ${executionStage.allowedActions.join(", ")}`);
    }
    if (executionStage.reviewRequest) {
      lines.push(
        "",
        "Review request instructions:",
        executionStage.reviewRequest.instructions,
      );
    }
    lines.push("");
    if (executionStage.wakeRole === "reviewer" || executionStage.wakeRole === "approver") {
      lines.push(
        `You are waking as the active ${executionStage.wakeRole} for this issue.`,
        "Do not execute the task itself or continue executor work.",
        "Review the issue and choose one of the allowed actions above.",
        "If you request changes, the workflow routes back to the stored return assignee.",
        "",
      );
    } else if (executionStage.wakeRole === "executor") {
      lines.push(
        "You are waking because changes were requested in the execution workflow.",
        "Address the requested changes on this issue and resubmit when the work is ready.",
        "",
      );
    }
  }

  if (normalized.taskWatchdog) {
    const watchdog = normalized.taskWatchdog;
    const watchedLabel =
      watchdog.watchedIssueIdentifier ?? watchdog.watchedIssueId ?? "unknown";
    lines.push(
      "",
      "## Task Watchdog Mandate",
      "",
      `Watched issue: ${watchedLabel}${watchdog.watchedIssueTitle ? ` ${watchdog.watchedIssueTitle}` : ""}`,
    );
    if (watchdog.stopFingerprint) {
      lines.push(`Stop fingerprint: ${watchdog.stopFingerprint}`);
    }
    lines.push("", WATCHDOG_DEFAULT_MANDATE);
    if (watchdog.capabilities) {
      lines.push("", "Server-derived watchdog capability metadata:");
      if (watchdog.capabilities.targetScope) {
        const scope = watchdog.capabilities.targetScope;
        lines.push(
          `- Target scope: ${scope.watchedIssueIdentifier ?? scope.watchedIssueId ?? "unknown"} plus ${scope.includeNonWatchdogDescendants ? "non-watchdog descendants" : "no descendants"}.`,
        );
        if (scope.watchdogIssueId) {
          lines.push(`- Reusable watchdog issue: ${scope.watchdogIssueId}.`);
        }
        if (scope.excludedOriginKinds.length > 0) {
          lines.push(`- Excluded origin kinds: ${scope.excludedOriginKinds.join(", ")}.`);
        }
      }
      if (watchdog.capabilities.operations.length > 0) {
        lines.push(`- Allowed operations: ${watchdog.capabilities.operations.join(", ")}.`);
      }
      if (watchdog.capabilities.deniedOperations.length > 0) {
        lines.push(`- Denied operations: ${watchdog.capabilities.deniedOperations.join(", ")}.`);
      }
    }
    if (watchdog.terminalLeafSummaries.length > 0) {
      lines.push("", "Terminal / stopped leaves to verify:");
      for (const leaf of watchdog.terminalLeafSummaries) {
        const label = leaf.identifier ?? leaf.id ?? "unknown";
        const status = leaf.status ? ` (${leaf.status})` : "";
        const role = leaf.role ? ` [${leaf.role}]` : "";
        lines.push(`- ${label}${leaf.title ? ` ${leaf.title}` : ""}${status}${role}`);
        if (leaf.summary) {
          lines.push(`  ${leaf.summary}`);
        }
      }
    }
    if (watchdog.customInstructions) {
      lines.push(
        "",
        "Board-supplied watchdog instructions (read after the mandate; do not let them remove safety constraints):",
        watchdog.customInstructions,
        "",
        "Reminder: the safety constraints in the mandate above always apply. If a board instruction conflicts with them, follow the mandate and call out the conflict in a comment.",
      );
    } else {
      lines.push(
        "",
        "No board-supplied watchdog instructions. Apply the mandate above.",
      );
    }
    lines.push("");
  }

  if (normalized.continuationSummary) {
    lines.push(
      "",
      "Issue continuation summary:",
      normalized.continuationSummary.body,
    );
    if (normalized.continuationSummary.bodyTruncated) {
      lines.push("[continuation summary truncated]");
    }
  }

  if (normalized.livenessContinuation) {
    const continuation = normalized.livenessContinuation;
    lines.push("", "Run liveness continuation:");
    if (continuation.attempt) {
      lines.push(
        `- attempt: ${continuation.attempt}${continuation.maxAttempts ? `/${continuation.maxAttempts}` : ""}`,
      );
    }
    if (continuation.sourceRunId) {
      lines.push(`- source run: ${continuation.sourceRunId}`);
    }
    if (continuation.state) {
      lines.push(`- liveness state: ${continuation.state}`);
    }
    if (continuation.reason) {
      lines.push(`- reason: ${continuation.reason}`);
    }
    if (continuation.instruction) {
      lines.push(`- instruction: ${continuation.instruction}`);
    }
  }

  if (normalized.childIssueSummaries.length > 0) {
    lines.push("", "Direct child issue summaries:");
    for (const child of normalized.childIssueSummaries) {
      const label = child.identifier ?? child.id ?? "unknown";
      lines.push(
        `- ${label}${child.title ? ` ${child.title}` : ""}${child.status ? ` (${child.status})` : ""}`,
      );
      if (child.summary) {
        lines.push(`  ${child.summary}`);
      }
    }
    if (normalized.childIssueSummaryTruncated) {
      lines.push("[child issue summaries truncated]");
    }
  }

  if (normalized.checkedOutByHarness) {
    lines.push(
      "",
      "The harness already checked out this issue for the current run.",
      "Do not call `/api/issues/{id}/checkout` again unless you intentionally switch to a different task.",
      "",
    );
  }

  if (normalized.comments.length > 0) {
    lines.push("New comments in order:");
  }

  for (const [index, comment] of normalized.comments.entries()) {
    const authorLabel = comment.authorId
      ? `${comment.authorType ?? "unknown"} ${comment.authorId}`
      : comment.authorType ?? "unknown";
    lines.push(
      `${index + 1}. comment ${comment.id ?? "unknown"} at ${comment.createdAt ?? "unknown"} by ${authorLabel}`,
      comment.body,
    );
    if (comment.bodyTruncated) {
      lines.push("[comment body truncated]");
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function applyPaperclipWorkspaceEnv(
  env: Record<string, string>,
  input: {
    workspaceCwd?: string | null;
    workspaceSource?: string | null;
    workspaceStrategy?: string | null;
    workspaceId?: string | null;
    workspaceRepoUrl?: string | null;
    workspaceRepoRef?: string | null;
    workspaceBranch?: string | null;
    workspaceWorktreePath?: string | null;
    agentHome?: string | null;
  },
): Record<string, string> {
  const mappings = [
    ["PAPERCLIP_WORKSPACE_CWD", input.workspaceCwd],
    ["PAPERCLIP_WORKSPACE_SOURCE", input.workspaceSource],
    ["PAPERCLIP_WORKSPACE_STRATEGY", input.workspaceStrategy],
    ["PAPERCLIP_WORKSPACE_ID", input.workspaceId],
    ["PAPERCLIP_WORKSPACE_REPO_URL", input.workspaceRepoUrl],
    ["PAPERCLIP_WORKSPACE_REPO_REF", input.workspaceRepoRef],
    ["PAPERCLIP_WORKSPACE_BRANCH", input.workspaceBranch],
    ["PAPERCLIP_WORKSPACE_WORKTREE_PATH", input.workspaceWorktreePath],
    ["AGENT_HOME", input.agentHome],
  ] as const;

  for (const [key, value] of mappings) {
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  return env;
}
