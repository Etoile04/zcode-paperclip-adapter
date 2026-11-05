/**
 * verify-local-agent-jwt.mjs — AC-4 local proof for the zcode_local credential gap.
 *
 * What it proves, end to end, without touching the Paperclip service:
 *
 *  1. The built package ENTRY (dist/index.js — the module the Paperclip plugin
 *     loader actually imports) declares `supportsLocalAgentJwt: true`, so the
 *     host will mint a per-run local agent JWT for zcode_local runs.
 *  2. A local agent JWT minted with the server's own algorithm (HS256 over a
 *     per-instance + per-company derived key) is accepted by the live Paperclip
 *     API: `GET /api/agents/me` answers 200.
 *  3. The adapter injects exactly that token into the CHILD PROCESS
 *     environment as PAPERCLIP_API_KEY — observed by running the adapter's
 *     real `execute()` against a stub zcode binary that dumps its own env.
 *  4. The value is not hardcoded: it comes from the host at run time, and the
 *     secret it is derived from is read from the environment only.
 *
 * Usage:
 *   npm run build
 *   PAPERCLIP_AGENT_JWT_SECRET=<host secret> \
 *   PAPERCLIP_API_URL=<paperclip base url> \
 *   node scripts/verify-local-agent-jwt.mjs
 *
 * Secret hygiene:
 *   - The signing SECRET is never written to disk and never printed. It is
 *     stripped from the environment handed to the child process, so it cannot
 *     reach the child's environment dump.
 *   - The minted TOKEN is a credential too: it lands in the temporary
 *     directory as part of that dump, and the directory is removed in a
 *     `finally` block, so it does not survive the script — including when a
 *     check throws.
 *   - Only the JWT's decoded claim set (non-secret metadata) and the HTTP
 *     status are printed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryModulePath = path.join(repoRoot, "dist", "index.js");

const failures = [];
function check(label, ok, detail) {
  const status = ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

/** Same derivation the server uses: HMAC-SHA256(master, "jwt:<instance>:<company>"). */
function deriveCompanySigningKey(masterSecret, companyId, instanceId) {
  return createHmac("sha256", masterSecret).update(`jwt:${instanceId}:${companyId}`).digest("hex");
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Mint a local agent JWT exactly the way the server's
 * `createLocalAgentJwt()` does (server/src/agent-auth-jwt.ts).
 *
 * One deliberate difference: `responsible_user_id` is `null` here, where a
 * real run token carries the responsible user's id. The claim set and the
 * signing key are otherwise identical to the server's, so the token is
 * peer-scoped — it identifies this agent, it does not escalate it.
 */
function createLocalAgentJwt({ masterSecret, agentId, companyId, adapterType, runId, instanceId, ttlSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    responsible_user_id: null,
    iat: now,
    exp: now + ttlSeconds,
    iss: "paperclip",
    aud: "paperclip-api",
    instance_id: instanceId,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signingKey = deriveCompanySigningKey(masterSecret, companyId, instanceId);
  const signature = createHmac("sha256", signingKey).update(signingInput).digest("base64url");
  return { token: `${signingInput}.${signature}`, claims };
}

/** Verify with the server's own comparison semantics (derived key, then legacy fallback). */
function verifyLocalAgentJwt(token, { masterSecret, instanceId }) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;
  const claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"));
  const signingInput = `${headerB64}.${claimsB64}`;
  const candidates = [
    deriveCompanySigningKey(masterSecret, claims.company_id, instanceId),
    masterSecret,
  ];
  for (const key of candidates) {
    const expected = createHmac("sha256", key).update(signingInput).digest("base64url");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length === b.length && timingSafeEqual(a, b)) return claims;
  }
  return null;
}

const masterSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
const apiUrl = (process.env.PAPERCLIP_API_URL ?? process.env.PAPERCLIP_LOCAL_API_URL ?? "").replace(/\/+$/, "");
const instanceId = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";

/**
 * Target guard. The request target comes from the operator's environment, not
 * from untrusted input, but the tool still refuses anything but http/https and
 * refuses private/loopback hosts unless the operator opts in explicitly —
 * a local Paperclip instance lives on 127.0.0.1, so the opt-in is the normal
 * case for this script.
 */
function assertAllowedTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`PAPERCLIP_API_URL is not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`refusing to call a non-http(s) URL: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal");
  if (isPrivate && process.env.PAPERCLIP_VERIFY_ALLOW_PRIVATE !== "1") {
    throw new Error(
      `refusing to call the private/loopback host ${host} — set PAPERCLIP_VERIFY_ALLOW_PRIVATE=1 to allow it`,
    );
  }
}

if (!masterSecret) {
  console.error("PAPERCLIP_AGENT_JWT_SECRET is not set — refusing to run.");
  process.exit(2);
}
if (!apiUrl) {
  console.error("PAPERCLIP_API_URL is not set — refusing to run.");
  process.exit(2);
}
try {
  assertAllowedTarget(apiUrl);
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. The built entry module declares the capability.
// ---------------------------------------------------------------------------
let createServerAdapter;
try {
  ({ createServerAdapter } = await import(entryModulePath));
} catch (err) {
  console.error(`Could not import ${entryModulePath} — run \`npm run build\` first.`);
  console.error(err);
  process.exit(2);
}

const adapter = createServerAdapter();
check(
  "built package entry declares supportsLocalAgentJwt",
  adapter.supportsLocalAgentJwt === true,
  `supportsLocalAgentJwt=${adapter.supportsLocalAgentJwt}`,
);

// ---------------------------------------------------------------------------
// 2. Mint a local agent JWT and confirm the live API accepts it.
// ---------------------------------------------------------------------------
const agentId = process.env.PAPERCLIP_AGENT_ID ?? "verify-agent";
const companyId = process.env.PAPERCLIP_COMPANY_ID ?? "verify-company";
const runId = process.env.PAPERCLIP_RUN_ID ?? `verify-run-${Date.now()}`;

const { token, claims } = createLocalAgentJwt({
  masterSecret,
  agentId,
  companyId,
  adapterType: "zcode_local",
  runId,
  instanceId,
  ttlSeconds: 3600,
});

const verified = verifyLocalAgentJwt(token, { masterSecret, instanceId });
check(
  "minted token verifies against the server's signing key derivation",
  verified !== null,
  `claims.sub=${claims.sub} instance_id=${claims.instance_id}`,
);

let meStatus = null;
let meBody = "";
try {
  const res = await fetch(`${apiUrl}/api/agents/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  meStatus = res.status;
  meBody = await res.text();
} catch (err) {
  check("GET /api/agents/me with the minted token", false, String(err));
}
if (meStatus !== null) {
  let identity = null;
  try {
    identity = JSON.parse(meBody)?.agent?.id ?? JSON.parse(meBody)?.id ?? null;
  } catch {
    identity = null;
  }
  check(
    "GET /api/agents/me with the minted token",
    meStatus === 200,
    `status=${meStatus}${identity ? ` agent=${identity}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// 3. The adapter injects that token into the CHILD PROCESS environment.
// ---------------------------------------------------------------------------
const workDir = mkdtempSync(path.join(tmpdir(), "zcode-local-jwt-verify-"));
const envDumpPath = path.join(workDir, "child-env.json");
const stubBinaryPath = path.join(workDir, "zcode-stub");

try {
  // The stub behaves like the zcode CLI for the two things this check needs:
  // it records the environment it was handed, and it emits a minimal valid
  // stream-json `result` event so the adapter can finish the run.
  writeFileSync(
    stubBinaryPath,
    `#!/bin/sh
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' ${JSON.stringify(envDumpPath)}
printf '%s\\n' '{"type":"result","sessionId":"sess_verify_local_jwt","response":"done","usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}'
`,
  );
  chmodSync(stubBinaryPath, 0o755);

  // The adapter merges the whole host environment into the child's, so the
  // signing secret would otherwise be inherited by the stub and land in the
  // environment dump on disk. The child never needs it — drop it before the
  // child runs. (`masterSecret` was already read into a variable above.)
  delete process.env["PAPERCLIP_AGENT_JWT_SECRET"];

  const childEnv = {};
  try {
    const result = await adapter.execute({
      runId,
      agent: {
        id: agentId,
        companyId,
        name: "Local JWT Verify Agent",
        adapterType: "zcode_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: workDir, zcodeCommand: stubBinaryPath, mode: "yolo", timeoutSec: 60 },
      context: {},
      onLog: async () => {},
      authToken: token,
    });
    Object.assign(childEnv, JSON.parse(readFileSync(envDumpPath, "utf8")));
    check(
      "adapter execute() completes with the stub binary",
      result.exitCode === 0,
      `exitCode=${result.exitCode}`,
    );
  } catch (err) {
    check("adapter execute() completes with the stub binary", false, String(err));
  }

  check(
    "child process env carries PAPERCLIP_API_KEY",
    typeof childEnv["PAPERCLIP_API_KEY"] === "string" && childEnv["PAPERCLIP_API_KEY"].length > 0,
    childEnv["PAPERCLIP_API_KEY"] ? "present" : "absent",
  );
  check(
    "child process env carries exactly the host-minted token",
    childEnv["PAPERCLIP_API_KEY"] === token,
    "byte-identical to the host value",
  );
  check(
    "child process env carries the run id",
    childEnv["PAPERCLIP_RUN_ID"] === runId,
    childEnv["PAPERCLIP_RUN_ID"] ?? "absent",
  );
  check(
    "child process env does not carry the signing secret",
    childEnv["PAPERCLIP_AGENT_JWT_SECRET"] === undefined,
    "stripped before the child ran",
  );
} finally {
  // Always remove the temp dir — including the environment dump, which holds
  // the minted token in plaintext — even when a check throws.
  rmSync(workDir, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
  console.error(`FAILED (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("All checks passed.");
