import { describe, expect, it } from "vitest";
import { sessionCodec } from "../src/server/index.js";

describe("sessionCodec", () => {
  it("round-trips sessionId and cwd", () => {
    const params = sessionCodec.serialize({ sessionId: "sess_abc", cwd: "/tmp/x" });
    expect(params).toEqual({ sessionId: "sess_abc", cwd: "/tmp/x" });
    expect(sessionCodec.deserialize(params)).toEqual({ sessionId: "sess_abc", cwd: "/tmp/x" });
  });

  it("rejects malformed payloads", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("sess_abc")).toBeNull();
    expect(sessionCodec.deserialize({ cwd: "/tmp" })).toBeNull();
    expect(sessionCodec.deserialize({ sessionId: 1, cwd: "/tmp" })).toBeNull();
    expect(sessionCodec.serialize({ random: true })).toBeNull();
  });

  it("accepts bare sessionId records (legacy hosts persist no cwd)", () => {
    expect(sessionCodec.deserialize({ sessionId: "sess_abc" })).toEqual({ sessionId: "sess_abc" });
    expect(sessionCodec.serialize({ sessionId: "sess_abc" })).toEqual({ sessionId: "sess_abc" });
  });

  it("exposes a short display id", () => {
    expect(sessionCodec.getDisplayId?.({ sessionId: "sess_6e44a252-cd21-4a66", cwd: "/tmp" })).toBe(
      "6e44a252-cd2",
    );
    expect(sessionCodec.getDisplayId?.(null)).toBeNull();
  });
});
