import { describe, expect, it } from "vitest";
import { MemoryStore, SupabaseStore } from "./store.js";
import type { CheckRecord, ReportRecord } from "./types.js";

const report: ReportRecord = {
  reporterId: "sentinel.near",
  targetId: "known-bad.near",
  reason: "A drain fixture for the store test.",
  evidence: "tx:demo9f3c0a7b1e8d4c2a6b5f0e1d9c8a7b6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b",
  confirmed: false,
  createdAtMs: Date.UTC(2026, 10, 1)
};

describe("MemoryStore", () => {
  it("dedupes reports and counts authorizations", async () => {
    const store = new MemoryStore();
    await store.upsertReport(report);
    await store.upsertReport({ ...report, confirmed: true });
    const rows = await store.listReports("known-bad.near");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confirmed).toBe(true);
    expect(await store.countAuthorizations("agent.near", "known-bad.near")).toBe(0);
    await store.recordInteraction({
      agentId: "agent.near",
      receiverId: "known-bad.near",
      methodName: "pay",
      decision: "allow",
      humanApproved: false,
      createdAtMs: Date.UTC(2026, 10, 2)
    });
    expect(await store.countAuthorizations("agent.near", "known-bad.near")).toBe(1);
  });
});

describe("SupabaseStore", () => {
  it("writes the service-role REST shape and reads it back", async () => {
    const calls: { url: string; method: string; body: string | null; prefer: string | null }[] = [];
    const saved: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : null;
      const headers = new Headers(init?.headers);
      calls.push({ url, method, body, prefer: headers.get("prefer") });
      if (method === "POST" && url.includes("/observations")) {
        saved.push(JSON.parse(body ?? "{}"));
        return new Response(null, { status: 201 });
      }
      if (method === "GET" && url.includes("/observations")) {
        return new Response(JSON.stringify(saved), { status: 200 });
      }
      if (method === "GET" && url.includes("/interactions")) {
        return new Response(JSON.stringify([{ id: "1" }]), {
          status: 200,
          headers: { "content-range": "0-0/1" }
        });
      }
      return new Response("[]", { status: 200 });
    };

    const store = new SupabaseStore({
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-test",
      fetchImpl
    });
    await store.saveObservation({
      accountId: "merchant.near",
      firstSeenAtMs: Date.UTC(2026, 10, 1),
      lastSeenAtMs: Date.UTC(2026, 10, 2),
      codeHash: "abc",
      previousCodeHash: null,
      codeHashChangedAtMs: null,
      chainCreatedAtMs: Date.UTC(2020, 0, 1),
      txCount: 12,
      blockHeight: 3,
      fullAccessKeys: 0,
      source: "test"
    });
    const loaded = await store.getObservation("merchant.near");
    expect(loaded?.accountId).toBe("merchant.near");
    expect(loaded?.txCount).toBe(12);
    expect(calls[0]?.url).toContain("https://example.supabase.co/rest/v1/observations");
    expect(calls[0]?.prefer).toContain("resolution=merge-duplicates");
    const count = await store.countAuthorizations("agent.near", "merchant.near");
    expect(count).toBe(1);
    const check: CheckRecord = {
      id: "5b0b8b8e-3c1a-4e5d-9f11-6a1d2c3b4e5f",
      agentId: "agent.near",
      receiverId: "merchant.near",
      methodName: "pay",
      decision: "allow",
      score: 0,
      reasons: [],
      signals: loaded
        ? {
            accountAgeMs: 1,
            txCount: 12,
            isContract: true,
            exists: true,
            codeChangedAtMs: null,
            priorAuthorizations: 1,
            reportCount: 0,
            confirmed: false,
            fullAccessKeys: 0,
            keyPageIncomplete: false,
            depositYocto: "0",
            amountYocto: "1",
            sources: { age: "t", activity: "t", code: "t", keys: "t", history: "t", blocklist: "t" }
          }
        : {
            accountAgeMs: null,
            txCount: null,
            isContract: false,
            exists: false,
            codeChangedAtMs: null,
            priorAuthorizations: 0,
            reportCount: 0,
            confirmed: false,
            fullAccessKeys: null,
            keyPageIncomplete: false,
            depositYocto: "0",
            amountYocto: "0",
            sources: { age: "t", activity: "t", code: "t", keys: "t", history: "t", blocklist: "t" }
          },
      createdAtMs: Date.UTC(2026, 10, 6)
    };
    await store.saveCheck(check);
    expect(calls.some((call) => call.url.includes("/checks"))).toBe(true);
  });
});
