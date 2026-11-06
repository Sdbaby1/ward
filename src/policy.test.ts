import { describe, expect, it } from "vitest";
import { DAY_MS, decide, HOUR_MS, type PolicyInput } from "./policy.js";

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const ONE = "1000000000000000000000000";
const MAX = "5000000000000000000000000";

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    nowMs: NOW,
    receiverId: "merchant.example.testnet",
    exists: true,
    isContract: true,
    createdAtMs: NOW - 400 * DAY_MS,
    txCount: 12000,
    codeChangedAtMs: null,
    fullAccessKeyCount: 0,
    keyPageIncomplete: false,
    priorAuthorizations: 4,
    reports: [],
    ownerConfirmed: false,
    depositYocto: "0",
    amountYocto: ONE,
    maxPerTxYocto: MAX,
    sources: {
      age: "test",
      activity: "test",
      code: "test",
      keys: "test",
      history: "test",
      blocklist: "test"
    },
    ...overrides
  };
}

describe("decide", () => {
  it("allows an old stable contract this agent has paid before", () => {
    const result = decide(input());
    expect(result.decision).toBe("allow");
    expect(result.score).toBe(0);
    expect(result.reasons.map((reason) => reason.code)).toContain("PRIOR_INTERACTION");
  });

  it("allows a first payment to an old stable contract", () => {
    const result = decide(input({ priorAuthorizations: 0 }));
    expect(result.decision).toBe("allow");
    expect(result.score).toBe(15);
    expect(result.reasons.map((reason) => reason.code)).toContain("FIRST_INTERACTION");
  });

  it("blocks a confirmed report", () => {
    const result = decide(
      input({
        priorAuthorizations: 0,
        reports: [
          {
            reporterId: "sentinel.ward.testnet",
            evidence: "tx:demo9f3c0a7b1e8d4c2a6b5f0e1d9c8a7b6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b",
            reason: "drain",
            confirmed: true
          }
        ]
      })
    );
    expect(result.decision).toBe("block");
    expect(result.score).toBe(100);
    expect(result.reasons[0]?.code).toBe("BLOCKLIST_CONFIRMED");
  });

  it("blocks at three independent reports", () => {
    const reports = ["a.near", "b.near", "c.near"].map((reporterId) => ({
      reporterId,
      evidence: "tx:demo9f3c0a7b1e8d4c2a6b5f0e1d9c8a7b6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b",
      reason: "same drain",
      confirmed: false
    }));
    const result = decide(input({ reports }));
    expect(result.decision).toBe("block");
    expect(result.reasons.map((reason) => reason.code)).toContain("REPORT_THRESHOLD");
  });

  it("warns on a single unconfirmed report", () => {
    const result = decide(
      input({
        reports: [
          {
            reporterId: "a.near",
            evidence: "https://explorer.example/tx/demo",
            reason: "suspicious",
            confirmed: false
          }
        ]
      })
    );
    expect(result.decision).toBe("warn");
    expect(result.reasons.map((reason) => reason.code)).toContain("REPORTS_PRESENT");
  });

  it("blocks a missing account", () => {
    const result = decide(
      input({
        receiverId: "missing.example.testnet",
        exists: false,
        isContract: false,
        createdAtMs: null,
        txCount: null,
        fullAccessKeyCount: null,
        priorAuthorizations: 0
      })
    );
    expect(result.decision).toBe("block");
    expect(result.reasons.map((reason) => reason.code)).toContain("ACCOUNT_MISSING");
  });

  it("blocks a first payment to an implicit account with no history", () => {
    const result = decide(
      input({
        receiverId: "a".repeat(64),
        isContract: false,
        createdAtMs: NOW - HOUR_MS,
        txCount: 0,
        fullAccessKeyCount: 1,
        priorAuthorizations: 0
      })
    );
    expect(result.decision).toBe("block");
    expect(result.reasons.map((reason) => reason.code)).toContain("IMPLICIT_NO_HISTORY");
  });

  it("warns when the account is under a day old", () => {
    const result = decide(
      input({
        receiverId: "young-shop.example.testnet",
        isContract: false,
        createdAtMs: NOW - 2 * HOUR_MS,
        txCount: 20,
        fullAccessKeyCount: 1,
        priorAuthorizations: 0
      })
    );
    expect(result.decision).toBe("warn");
    expect(result.score).toBe(60);
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "ACCOUNT_AGE_UNDER_DAY",
      "NO_CONTRACT_CODE",
      "FIRST_INTERACTION"
    ]);
  });

  it("warns when age is unknown", () => {
    const result = decide(input({ createdAtMs: null }));
    expect(result.decision).toBe("warn");
    expect(result.reasons.map((reason) => reason.code)).toContain("ACCOUNT_AGE_UNKNOWN");
  });

  it("warns when contract code changed inside 48 hours", () => {
    const result = decide(input({ priorAuthorizations: 0, codeChangedAtMs: NOW - HOUR_MS }));
    expect(result.decision).toBe("warn");
    expect(result.reasons.map((reason) => reason.code)).toContain("CODE_CHANGED_RECENTLY");
  });

  it("warns when a contract still has a full-access key", () => {
    const result = decide(input({ fullAccessKeyCount: 1 }));
    expect(result.decision).toBe("warn");
    expect(result.reasons.map((reason) => reason.code)).toContain("CONTRACT_HAS_FULL_ACCESS_KEY");
  });

  it("warns on an attached deposit and blocks an amount above the treasury max", () => {
    expect(decide(input({ depositYocto: "1" })).decision).toBe("warn");
    const over = decide(input({ amountYocto: "9000000000000000000000000" }));
    expect(over.decision).toBe("block");
    expect(over.reasons.map((reason) => reason.code)).toContain("AMOUNT_OVER_MAX");
  });

  it("rejects a malformed amount", () => {
    expect(() => decide(input({ amountYocto: "1.5" }))).toThrow(/yoctoNEAR/);
  });
});
