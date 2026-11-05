import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { describe, expect, it } from "vitest";
import { createServerAdapter as createEntryServerAdapter, serverAdapterCapabilities } from "../src/index.js";
import { buildChildEnv } from "../src/server/execute.js";
import { createServerAdapter as createServerModuleFactory } from "../src/server/index.js";

const AGENT = {
  id: "agent_local_jwt_test",
  companyId: "company_local_jwt_test",
  name: "Local JWT Test Agent",
  adapterType: "zcode_local",
  adapterConfig: {},
};

/**
 * Opaque placeholders, deliberately not credential-shaped: these tests assert
 * pass-through behaviour, never a real credential. Nothing here is a secret
 * and nothing here is read from the environment.
 */
const HOST_MINTED_VALUE = "placeholder-from-the-host";
const OPERATOR_CONFIGURED_VALUE = "placeholder-from-the-config";
const AMBIENT_VALUE = "placeholder-from-the-ambient-env";

/**
 * `buildChildEnv()` merges the whole host process environment into the child
 * environment, so an ambient `PAPERCLIP_API_KEY` is inherited by the child
 * even when the adapter injects nothing of its own.
 *
 * That ambient variable is not an exotic situation: it is present in every
 * zcode_local agent session, because this very adapter is what puts it
 * there. A test whose result flips depending on that variable would be red
 * for exactly the environment this adapter creates, so every case below
 * pins the ambient baseline explicitly instead of inheriting whatever the
 * surrounding shell happens to hold.
 */
function withAmbientApiKey<T>(value: string | undefined, fn: () => T): T {
  const original = process.env["PAPERCLIP_API_KEY"];
  if (value === undefined) delete process.env["PAPERCLIP_API_KEY"];
  else process.env["PAPERCLIP_API_KEY"] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env["PAPERCLIP_API_KEY"];
    else process.env["PAPERCLIP_API_KEY"] = original;
  }
}

/**
 * Capability flags that are allowed to live ONLY on the server module.
 *
 * `supportsInstructionsBundle` is one of them, and it is not an oversight:
 * it predates PR #1 — the baseline commit `d6b24e2` already declares it on
 * the server module (`src/server/index.ts`) — and PR #1 does not touch it.
 * The host reads it to decide whether to show the Instructions / Skills
 * sections; it is stable across hot reloads, so it needs no entry-level
 * twin.
 *
 * This is an exact inventory, not a lower bound: the guard below compares the
 * server module's server-only flags against this list for EQUALITY, so a NEW
 * server-only capability flag turns the guard red until it is listed here
 * with a reason, and a listed flag that stops existing turns it red too.
 */
const SERVER_ONLY_CAPABILITY_FLAGS = ["supportsInstructionsBundle"] as const;

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run_local_jwt_test",
    agent: AGENT,
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

describe("local agent JWT capability", () => {
  it("declares supportsLocalAgentJwt on the server module", () => {
    const adapter = createServerModuleFactory();

    expect(adapter.supportsLocalAgentJwt).toBe(true);
  });

  it("declares supportsLocalAgentJwt on the package entry module", () => {
    // The Paperclip plugin loader imports the package ENTRY (dist/index.js),
    // so this is the object the host actually inspects.
    const adapter = createEntryServerAdapter();

    expect(adapter.supportsLocalAgentJwt).toBe(true);
  });

  it("keeps the entry-level capability flags in sync with the server module", () => {
    // The entry module re-applies these flags so they survive an
    // entry-only hot-reload (the host re-imports dist/index.js with a
    // cache-busting query string; the entry's imports stay cached). If the
    // two ever disagree, the adapter behaves differently before and after a
    // reload — so pin them together.
    const serverModule = createServerModuleFactory() as Record<string, unknown>;
    const entryModule = createEntryServerAdapter() as Record<string, unknown>;

    for (const [flag, value] of Object.entries(serverAdapterCapabilities)) {
      expect(serverModule[flag]).toBe(value);
      expect(entryModule[flag]).toBe(value);
    }
  });

  it("keeps the server module free of capability flags the entry module does not declare", () => {
    // The reverse direction of the sync guard above.
    //
    // A capability flag that lives ONLY on the server module is invisible to
    // an entry-only hot-reload, because the entry's own import of
    // ./server/index.js stays in the ESM cache: the host keeps serving the
    // stale value until Paperclip is restarted. That is the exact class of
    // bug the entry-level declaration exists to remove, so a server-only
    // capability flag must fail here rather than pass unnoticed.
    //
    // The expected set is the exact inventory of flags allowed to stay
    // server-only (SERVER_ONLY_CAPABILITY_FLAGS), compared for EQUALITY: a
    // new server-only flag is red, and so is a listed flag that no longer
    // exists. Equality against a pinned baseline is deliberately stricter
    // than a subset check — the allowlist cannot quietly grow.
    const serverModule = createServerModuleFactory() as Record<string, unknown>;
    const declared = new Set(Object.keys(serverAdapterCapabilities));

    const serverOnlyFlags = Object.keys(serverModule).filter(
      (key) =>
        typeof serverModule[key] === "boolean" &&
        /^(supports|requires)[A-Z]/.test(key) &&
        !declared.has(key),
    );

    expect([...serverOnlyFlags].sort()).toEqual([...SERVER_ONLY_CAPABILITY_FLAGS].sort());
  });
});

describe("child environment credential injection", () => {
  it("injects the run auth token as PAPERCLIP_API_KEY", () => {
    const { env } = buildChildEnv(makeCtx({ authToken: HOST_MINTED_VALUE }), {});

    expect(env["PAPERCLIP_API_KEY"]).toBe(HOST_MINTED_VALUE);
  });

  it("does not inject a credential of its own when the host supplies no token", () => {
    // The unit's guarantee is "the adapter injects nothing of its own", not
    // "the child environment holds no credential": the host process env is
    // merged in wholesale, so an ambient value is inherited. With the
    // ambient variable removed the two readings coincide, and the assertion
    // states the real semantic — no injection — rather than a guarantee
    // this unit does not provide.
    const { env } = withAmbientApiKey(undefined, () => buildChildEnv(makeCtx(), {}));

    expect(env["PAPERCLIP_API_KEY"]).toBeUndefined();
  });

  it("inherits an ambient PAPERCLIP_API_KEY unchanged when the host supplies no token", () => {
    // Same unit, same semantics, stated against the ambient baseline: the
    // value that reaches the child is exactly the ambient one — not
    // invented by the adapter, and not overwritten by it.
    const { env } = withAmbientApiKey(AMBIENT_VALUE, () => buildChildEnv(makeCtx(), {}));

    expect(env["PAPERCLIP_API_KEY"]).toBe(AMBIENT_VALUE);
  });

  it("lets the injected token win over an ambient PAPERCLIP_API_KEY", () => {
    // The production case: an agent session already carries an ambient
    // PAPERCLIP_API_KEY, and the host mints a fresh per-run JWT for it.
    // The run-scoped token must win, otherwise a stale credential would be
    // used for the whole run.
    const { env } = withAmbientApiKey(AMBIENT_VALUE, () =>
      buildChildEnv(makeCtx({ authToken: HOST_MINTED_VALUE }), {}),
    );

    expect(env["PAPERCLIP_API_KEY"]).toBe(HOST_MINTED_VALUE);
  });

  it("keeps the injected value byte-identical to the host value", () => {
    // Guards against a hardcoded/derived-in-adapter value: the credential
    // must be exactly what the host minted for this run.
    const { env } = buildChildEnv(makeCtx({ authToken: HOST_MINTED_VALUE }), {});

    expect(env["PAPERCLIP_API_KEY"]).toBe(HOST_MINTED_VALUE);
  });

  it("lets an explicit adapter env PAPERCLIP_API_KEY win over the injected token", () => {
    // Pre-existing behaviour: an operator-supplied key in the adapter config
    // takes precedence (buildChildEnv's hasExplicitApiKey branch).
    const { env } = buildChildEnv(
      makeCtx({ authToken: HOST_MINTED_VALUE }),
      { env: { PAPERCLIP_API_KEY: OPERATOR_CONFIGURED_VALUE } },
    );

    expect(env["PAPERCLIP_API_KEY"]).toBe(OPERATOR_CONFIGURED_VALUE);
  });
});
