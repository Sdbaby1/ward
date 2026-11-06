import { EMPTY_CODE_HASH } from "./account.js";
import type { ChainReader } from "./chain.js";
import { MemoryStore, type Store } from "./store.js";
import type { AccountSnapshot, OnChainTarget, ReportRecord } from "./types.js";

export const DEMO_AGENT = "pay-agent.ward.testnet";
export const DEMO_TREASURY = "treasury.ward.testnet";
export const DEMO_OWNER = "owner.ward.testnet";
export const DEMO_KNOWN_BAD = "known-bad.ward.testnet";
export const DEMO_MERCHANT = "merchant.example.testnet";
export const DEMO_YOUNG = "young-shop.example.testnet";
export const DEMO_CHANGED = "proxy.example.testnet";
export const DEMO_IMPLICIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const DEMO_MISSING = "missing.example.testnet";
export const DEMO_PUBLIC_KEY = "ed25519:DemoWardFunctionCallKey111111111111111111111111111111";
export const DEMO_ALLOWANCE = "250000000000000000000000";
export const DEMO_MAX_PER_TX = "5000000000000000000000000";
export const DEMO_EVIDENCE =
  "tx:demo9f3c0a7b1e8d4c2a6b5f0e1d9c8a7b6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b";

const MERCHANT_CODE = "4DmerchantCodeHashDemo1111111111111111111111111111";
const CHANGED_CODE = "4DchangedCodeHashDemo11111111111111111111111111111";
const BAD_CODE = "4DknownBadCodeHashDemo1111111111111111111111111111";

const FIXTURE_SOURCES = {
  account: "fixture",
  age: "fixture",
  activity: "fixture",
  code: "fixture",
  keys: "fixture"
};

export function demoAccounts(nowMs: number): Record<string, AccountSnapshot> {
  const day = 24 * 60 * 60 * 1000;
  return {
    [DEMO_KNOWN_BAD]: account({
      exists: true,
      codeHash: BAD_CODE,
      isContract: true,
      createdAtMs: nowMs - 20 * day,
      txCount: 40,
      fullAccessKeyCount: 1,
      balanceYocto: "1000000000000000000000000"
    }),
    [DEMO_MERCHANT]: account({
      exists: true,
      codeHash: MERCHANT_CODE,
      isContract: true,
      createdAtMs: nowMs - 400 * day,
      txCount: 12000,
      fullAccessKeyCount: 0,
      balanceYocto: "25000000000000000000000000"
    }),
    [DEMO_YOUNG]: account({
      exists: true,
      codeHash: EMPTY_CODE_HASH,
      isContract: false,
      createdAtMs: nowMs - 2 * 60 * 60 * 1000,
      txCount: 20,
      fullAccessKeyCount: 1,
      balanceYocto: "3000000000000000000000000"
    }),
    [DEMO_CHANGED]: account({
      exists: true,
      codeHash: CHANGED_CODE,
      isContract: true,
      createdAtMs: nowMs - 200 * day,
      txCount: 800,
      lastDeployAtMs: nowMs - 60 * 60 * 1000,
      fullAccessKeyCount: 0,
      balanceYocto: "8000000000000000000000000"
    }),
    [DEMO_IMPLICIT]: account({
      exists: true,
      codeHash: EMPTY_CODE_HASH,
      isContract: false,
      createdAtMs: nowMs - 60 * 60 * 1000,
      txCount: 0,
      fullAccessKeyCount: 1,
      balanceYocto: "0"
    }),
    [DEMO_TREASURY]: account({
      exists: true,
      codeHash: MERCHANT_CODE,
      isContract: true,
      createdAtMs: nowMs - 30 * day,
      txCount: 15,
      fullAccessKeyCount: 1,
      balanceYocto: "100000000000000000000000000"
    })
  };
}

function account(partial: {
  exists: boolean;
  codeHash: string;
  isContract: boolean;
  createdAtMs: number;
  txCount: number;
  fullAccessKeyCount: number;
  balanceYocto: string;
  lastDeployAtMs?: number;
}): AccountSnapshot {
  return {
    exists: partial.exists,
    balanceYocto: partial.balanceYocto,
    codeHash: partial.codeHash,
    isContract: partial.isContract,
    createdAtMs: partial.createdAtMs,
    txCount: partial.txCount,
    lastDeployAtMs: partial.lastDeployAtMs ?? null,
    fullAccessKeyCount: partial.fullAccessKeyCount,
    keyPageIncomplete: false,
    blockHeight: 1,
    sources: FIXTURE_SOURCES
  };
}

export function demoReport(nowMs: number): ReportRecord {
  return {
    reporterId: "sentinel.ward.testnet",
    targetId: DEMO_KNOWN_BAD,
    reason: "Prompt-injection drain fixture used by the Ward attack demo.",
    evidence: DEMO_EVIDENCE,
    confirmed: true,
    createdAtMs: nowMs - 24 * 60 * 60 * 1000
  };
}

export class FixtureChainReader implements ChainReader {
  constructor(
    private readonly accounts: Record<string, AccountSnapshot>,
    private readonly targets: Record<string, OnChainTarget> = {}
  ) {}

  async getAccount(accountId: string): Promise<AccountSnapshot> {
    const found = this.accounts[accountId];
    if (found) return found;
    return {
      exists: false,
      balanceYocto: "0",
      codeHash: null,
      isContract: false,
      createdAtMs: null,
      txCount: null,
      lastDeployAtMs: null,
      fullAccessKeyCount: null,
      keyPageIncomplete: false,
      blockHeight: null,
      sources: {
        account: "fixture: account not in the demo set",
        age: "not queried",
        activity: "not queried",
        code: "not queried",
        keys: "not queried"
      }
    };
  }

  async getOnChainTarget(accountId: string): Promise<OnChainTarget | null> {
    return this.targets[accountId] ?? null;
  }
}

export async function seedDemoStore(store: Store, nowMs: number): Promise<void> {
  await store.upsertReport(demoReport(nowMs));
  await store.recordInteraction({
    agentId: DEMO_AGENT,
    receiverId: DEMO_MERCHANT,
    methodName: "pay",
    decision: "allow",
    humanApproved: false,
    createdAtMs: nowMs - 9 * 24 * 60 * 60 * 1000
  });
  await store.recordInteraction({
    agentId: DEMO_AGENT,
    receiverId: DEMO_MERCHANT,
    methodName: "pay",
    decision: "allow",
    humanApproved: false,
    createdAtMs: nowMs - 8 * 24 * 60 * 60 * 1000
  });
  await store.recordInteraction({
    agentId: DEMO_AGENT,
    receiverId: DEMO_MERCHANT,
    methodName: "pay",
    decision: "allow",
    humanApproved: false,
    createdAtMs: nowMs - 7 * 24 * 60 * 60 * 1000
  });
  await store.recordInteraction({
    agentId: DEMO_AGENT,
    receiverId: DEMO_MERCHANT,
    methodName: "pay",
    decision: "allow",
    humanApproved: false,
    createdAtMs: nowMs - 6 * 24 * 60 * 60 * 1000
  });
}

export function createDemoChain(nowMs: number): FixtureChainReader {
  const report = demoReport(nowMs);
  return new FixtureChainReader(demoAccounts(nowMs), {
    [DEMO_KNOWN_BAD]: {
      blocked: true,
      ownerConfirmed: true,
      reportCount: 1,
      reports: [report]
    }
  });
}

export async function createDemoStore(nowMs: number): Promise<MemoryStore> {
  const store = new MemoryStore();
  await seedDemoStore(store, nowMs);
  return store;
}
