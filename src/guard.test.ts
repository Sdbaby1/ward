import { describe, expect, it } from "vitest";
import { ChainUnavailable, type CheckResult } from "./types.js";
import {
  assertCanSign,
  guardedPay,
  KeyScopeError,
  RecordingSigner,
  type AgentKey,
  type PaymentIntent
} from "./guard.js";

const treasury = "treasury.ward.testnet";

function key(overrides: Partial<AgentKey> = {}): AgentKey {
  return {
    accountId: "pay-agent.ward.testnet",
    publicKey: "ed25519:DemoWardFunctionCallKey111111111111111111111111111111",
    permission: {
      type: "FunctionCall",
      receiverId: treasury,
      methodNames: ["pay"],
      allowanceYocto: "250000000000000000000000"
    },
    ...overrides
  };
}

function payment(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    receiverId: treasury,
    methodName: "pay",
    depositYocto: "0",
    args: {
      counterparty: "merchant.example.testnet",
      amountYocto: "1000000000000000000000000"
    },
    ...overrides
  };
}

const allow: CheckResult = {
  decision: "allow",
  score: 0,
  reasons: [],
  signals: {
    accountAgeMs: 1,
    txCount: 10,
    isContract: true,
    exists: true,
    codeChangedAtMs: null,
    priorAuthorizations: 1,
    reportCount: 0,
    confirmed: false,
    fullAccessKeys: 0,
    keyPageIncomplete: false,
    depositYocto: "0",
    amountYocto: "1000000000000000000000000",
    sources: { age: "t", activity: "t", code: "t", keys: "t", history: "t", blocklist: "t" }
  }
};

describe("function-call key scope", () => {
  it("accepts the treasury pay key", () => {
    expect(() => assertCanSign(key(), payment(), treasury)).not.toThrow();
  });

  it("rejects a full-access key before any check", async () => {
    const signer = new RecordingSigner();
    await expect(
      guardedPay({
        key: key({ permission: { type: "FullAccess" } }),
        treasuryId: treasury,
        intent: payment(),
        checker: { check: async () => allow },
        signer,
        askHuman: async () => true
      })
    ).rejects.toBeInstanceOf(KeyScopeError);
    expect(signer.signed).toHaveLength(0);
  });

  it("rejects a direct transfer to another account", () => {
    expect(() =>
      assertCanSign(key(), payment({ receiverId: "known-bad.ward.testnet" }), treasury)
    ).toThrow(/can only call treasury.ward.testnet/);
  });

  it("rejects any method other than pay, an attached deposit, and an unlimited allowance", () => {
    expect(() => assertCanSign(key(), payment({ methodName: "withdraw" }), treasury)).toThrow(/cannot call withdraw/);
    expect(() => assertCanSign(key(), payment({ depositYocto: "1" }), treasury)).toThrow(/cannot attach NEAR/);
    const open = key();
    if (open.permission.type === "FunctionCall") open.permission.allowanceYocto = "0";
    expect(() => assertCanSign(open, payment(), treasury)).toThrow(/allowance is 0/);
  });
});

describe("guardedPay", () => {
  it("does not sign a block", async () => {
    const signer = new RecordingSigner();
    const result = await guardedPay({
      key: key(),
      treasuryId: treasury,
      intent: payment(),
      checker: { check: async () => ({ ...allow, decision: "block" }) },
      signer,
      askHuman: async () => true
    });
    expect(result.signed).toBe(false);
    expect(result.outcome).toBe("stopped");
    expect(signer.signed).toHaveLength(0);
  });

  it("asks a human on warn and signs only after approval", async () => {
    const denied = new RecordingSigner();
    const no = await guardedPay({
      key: key(),
      treasuryId: treasury,
      intent: payment(),
      checker: { check: async () => ({ ...allow, decision: "warn" }) },
      signer: denied,
      askHuman: async () => false
    });
    expect(no.outcome).toBe("human_rejected");
    expect(denied.signed).toHaveLength(0);

    const approved = new RecordingSigner();
    const yes = await guardedPay({
      key: key(),
      treasuryId: treasury,
      intent: payment(),
      checker: { check: async () => ({ ...allow, decision: "warn" }) },
      signer: approved,
      askHuman: async () => true
    });
    expect(yes.signed).toBe(true);
    expect(approved.signed).toHaveLength(1);
  });

  it("does not sign when the chain check fails", async () => {
    const signer = new RecordingSigner();
    const result = await guardedPay({
      key: key(),
      treasuryId: treasury,
      intent: payment(),
      checker: {
        check: async () => {
          throw new ChainUnavailable("rpc down");
        }
      },
      signer,
      askHuman: async () => true
    });
    expect(result.signed).toBe(false);
    expect(result.detail).toMatch(/failed closed/);
    expect(signer.signed).toHaveLength(0);
  });
});
