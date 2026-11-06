import { describe, expect, it } from "vitest";
import type { ChainReader } from "./chain.js";
import { MemoryStore } from "./store.js";
import { createWardService } from "./service.js";
import type { AccountSnapshot } from "./types.js";

const sources = {
  account: "test",
  age: "test",
  activity: "test",
  code: "test",
  keys: "test"
};

function snapshot(codeHash: string): AccountSnapshot {
  return {
    exists: true,
    balanceYocto: "1",
    codeHash,
    isContract: true,
    createdAtMs: Date.UTC(2020, 0, 1),
    txCount: 100,
    lastDeployAtMs: null,
    fullAccessKeyCount: 0,
    keyPageIncomplete: false,
    blockHeight: 1,
    sources
  };
}

describe("evaluate", () => {
  it("treats a code hash change since the last observation as a recent change", async () => {
    const store = new MemoryStore();
    let current = snapshot("hash-a");
    const chain: ChainReader = {
      async getAccount() {
        return current;
      },
      async getOnChainTarget() {
        return null;
      }
    };
    const service = createWardService({
      store,
      chain,
      contractId: null,
      maxPerTxYocto: "5000000000000000000000000"
    });
    const now = Date.UTC(2026, 10, 6);
    const first = await service.evaluate(
      {
        agentId: "agent.near",
        receiverId: "merchant.near",
        methodName: "pay",
        depositYocto: "0",
        amountYocto: "1000000000000000000000000"
      },
      now
    );
    expect(first.decision).toBe("allow");

    current = snapshot("hash-b");
    const second = await service.evaluate(
      {
        agentId: "agent.near",
        receiverId: "merchant.near",
        methodName: "pay",
        depositYocto: "0",
        amountYocto: "1000000000000000000000000"
      },
      now + 1000
    );
    expect(second.decision).toBe("warn");
    expect(second.reasons.map((reason) => reason.code)).toContain("CODE_CHANGED_RECENTLY");
    expect(second.signals.priorAuthorizations).toBe(0);
  });
});
