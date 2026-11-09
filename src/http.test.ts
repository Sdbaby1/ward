import { describe, expect, it } from "vitest";
import { createApp } from "./http.js";
import { createDemoChain, createDemoStore, DEMO_AGENT, DEMO_ALLOWANCE, DEMO_KNOWN_BAD, DEMO_MAX_PER_TX, DEMO_MERCHANT, DEMO_PUBLIC_KEY, DEMO_TREASURY, DEMO_YOUNG } from "./fixtures.js";
import type { AgentKey } from "./guard.js";
import { createWardService } from "./service.js";
import { ChainUnavailable } from "./types.js";
import type { ChainReader } from "./chain.js";
import { MemoryStore } from "./store.js";

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

async function demoApp() {
  const store = await createDemoStore(NOW);
  const chain = createDemoChain(NOW);
  const service = createWardService({
    store,
    chain,
    contractId: DEMO_TREASURY,
    maxPerTxYocto: DEMO_MAX_PER_TX
  });
  const agentKey: AgentKey = {
    accountId: DEMO_AGENT,
    publicKey: DEMO_PUBLIC_KEY,
    permission: {
      type: "FunctionCall",
      receiverId: DEMO_TREASURY,
      methodNames: ["pay"],
      allowanceYocto: DEMO_ALLOWANCE
    }
  };
  return createApp({
    service,
    store,
    network: "testnet",
    treasuryId: DEMO_TREASURY,
    contractId: DEMO_TREASURY,
    agentKey,
    chainMode: "fixture",
    now: () => NOW
  });
}

describe("HTTP app", () => {
  it("serves the dashboard and health", async () => {
    const app = await demoApp();
    const page = await app.request("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Ward");
    const health = await app.request("/api/health");
    expect(await health.json()).toMatchObject({ ok: true, store: "memory", chain: "fixture" });
  });

  it("blocks the known-bad receiver and allows the merchant", async () => {
    const app = await demoApp();
    const blocked = await app.request("/api/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: DEMO_AGENT,
        receiverId: DEMO_KNOWN_BAD,
        methodName: "pay",
        depositYocto: "0",
        amountYocto: "1000000000000000000000000"
      })
    });
    expect(blocked.status).toBe(200);
    const blockedBody = await blocked.json();
    expect(blockedBody.decision).toBe("block");
    expect(blockedBody.phase).toBe("stopped");
    expect(blockedBody.next).toBe("stop");

    const pay = await app.request("/api/v1/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        counterparty: DEMO_KNOWN_BAD,
        amountYocto: "1000000000000000000000000",
        humanApproved: true
      })
    });
    expect(pay.status).toBe(403);
    const stoppedBody = await pay.json();
    expect(stoppedBody.signed).toBe(false);
    expect(stoppedBody.phase).toBe("stopped");
    expect(stoppedBody.next).toBe("stop");

    const allowed = await app.request("/api/v1/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        counterparty: DEMO_MERCHANT,
        amountYocto: "1000000000000000000000000"
      })
    });
    expect(allowed.status).toBe(200);
    const allowedBody = await allowed.json();
    expect(allowedBody.signed).toBe(true);
    expect(allowedBody.phase).toBe("signed");
    expect(allowedBody.next).toBe("none");
    expect(allowedBody.nearCli).toContain("call-function as-transaction");
    expect(allowedBody.nearCli).toContain(DEMO_MERCHANT);
  });

  it("asks for a human on warn and does not let the report API confirm", async () => {
    const app = await demoApp();
    const warn = await app.request("/api/v1/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        counterparty: DEMO_YOUNG,
        amountYocto: "1000000000000000000000000"
      })
    });
    expect(warn.status).toBe(409);
    const rejectedBody = await warn.json();
    expect(rejectedBody.phase).toBe("rejected");
    expect(rejectedBody.next).toBe("stop");
    const approved = await app.request("/api/v1/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        counterparty: DEMO_YOUNG,
        amountYocto: "1000000000000000000000000",
        humanApproved: true
      })
    });
    expect(approved.status).toBe(200);

    const filed = await app.request("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reporterId: "sentinel.ward.testnet",
        targetId: "other.example.testnet",
        reason: "Evidence-backed report from the test suite.",
        evidence: "tx:demo9f3c0a7b1e8d4c2a6b5f0e1d9c8a7b6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b"
      })
    });
    expect(filed.status).toBe(200);
    expect((await filed.json()).confirmed).toBe(false);
    const rejected = await app.request("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reporterId: "sentinel.ward.testnet",
        targetId: "other.example.testnet",
        reason: "short",
        evidence: "nope"
      })
    });
    expect(rejected.status).toBe(400);
  });

  it("does not sign when the chain is unavailable", async () => {
    const store = new MemoryStore();
    const chain: ChainReader = {
      async getAccount() {
        throw new ChainUnavailable("rpc down");
      },
      async getOnChainTarget() {
        return null;
      }
    };
    const service = createWardService({
      store,
      chain,
      contractId: null,
      maxPerTxYocto: DEMO_MAX_PER_TX
    });
    const app = createApp({
      service,
      store,
      network: "testnet",
      treasuryId: DEMO_TREASURY,
      contractId: null,
      agentKey: {
        accountId: DEMO_AGENT,
        publicKey: DEMO_PUBLIC_KEY,
        permission: {
          type: "FunctionCall",
          receiverId: DEMO_TREASURY,
          methodNames: ["pay"],
          allowanceYocto: DEMO_ALLOWANCE
        }
      },
      chainMode: "rpc",
      now: () => NOW
    });
    const check = await app.request("/api/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: DEMO_AGENT,
        receiverId: DEMO_MERCHANT,
        amountYocto: "1000000000000000000000000"
      })
    });
    expect(check.status).toBe(503);
    const pay = await app.request("/api/v1/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        counterparty: DEMO_MERCHANT,
        amountYocto: "1000000000000000000000000",
        humanApproved: true
      })
    });
    expect(pay.status).toBe(403);
    const stopped = await pay.json();
    expect(stopped.signed).toBe(false);
    expect(stopped.next).toBe("retry");
  });
});
