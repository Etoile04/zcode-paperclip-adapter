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
});

describe("child environment credential injection", () => {
  it("injects the run auth token as PAPERCLIP_API_KEY", () => {
    const { env } = buildChildEnv(makeCtx({ authToken: HOST_MINTED_VALUE }), {});

    expect(env["PAPERCLIP_API_KEY"]).toBe(HOST_MINTED_VALUE);
  });

  it("does not invent a credential when the host supplies no token", () => {
    const { env } = buildChildEnv(makeCtx(), {});

    expect(env["PAPERCLIP_API_KEY"]).toBeUndefined();
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
