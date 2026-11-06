import { randomUUID } from "node:crypto";
import { isEmptyCodeHash, normalizeAccountId, parseYocto } from "./account.js";
import { mergeReports, type ChainReader } from "./chain.js";
import { decide, type PolicyInput } from "./policy.js";
import type { Store } from "./store.js";
import type { CheckRecord, CheckResult, Observation, Signals } from "./types.js";

export interface EvaluateInput {
  agentId: string;
  receiverId: string;
  methodName: string;
  depositYocto: string;
  amountYocto: string;
}

export interface WardService {
  store: Store;
  chain: ChainReader;
  contractId: string | null;
  maxPerTxYocto: string;
  evaluate(input: EvaluateInput, nowMs: number): Promise<CheckResult>;
}

export function createWardService(options: {
  store: Store;
  chain: ChainReader;
  contractId: string | null;
  maxPerTxYocto: string;
}): WardService {
  return {
    store: options.store,
    chain: options.chain,
    contractId: options.contractId,
    maxPerTxYocto: options.maxPerTxYocto,
    evaluate: (input, nowMs) => evaluate(options, input, nowMs)
  };
}

async function evaluate(
  options: {
    store: Store;
    chain: ChainReader;
    contractId: string | null;
    maxPerTxYocto: string;
  },
  input: EvaluateInput,
  nowMs: number
): Promise<CheckResult> {
  const agentId = normalizeAccountId(input.agentId);
  const receiverId = normalizeAccountId(input.receiverId);
  parseYocto(input.depositYocto);
  parseYocto(input.amountYocto);
  if (input.methodName.length === 0 || input.methodName.length > 64) {
    throw new Error("Method name is empty or too long.");
  }

  const snapshot = await options.chain.getAccount(receiverId);
  const previous = await options.store.getObservation(receiverId);
  let codeChangedAtMs = snapshot.lastDeployAtMs;
  if (
    previous?.codeHash &&
    snapshot.codeHash &&
    previous.codeHash !== snapshot.codeHash &&
    !isEmptyCodeHash(snapshot.codeHash)
  ) {
    codeChangedAtMs = nowMs;
  } else if (
    previous?.codeHash &&
    previous.codeHash === snapshot.codeHash &&
    previous.codeHashChangedAtMs !== null
  ) {
    codeChangedAtMs = previous.codeHashChangedAtMs;
  }

  const observation: Observation = {
    accountId: receiverId,
    firstSeenAtMs: previous?.firstSeenAtMs ?? nowMs,
    lastSeenAtMs: nowMs,
    codeHash: snapshot.codeHash,
    previousCodeHash: previous?.codeHash ?? null,
    codeHashChangedAtMs: codeChangedAtMs,
    chainCreatedAtMs: snapshot.createdAtMs,
    txCount: snapshot.txCount,
    blockHeight: snapshot.blockHeight,
    fullAccessKeys: snapshot.fullAccessKeyCount,
    source: snapshot.sources.account
  };
  await options.store.saveObservation(observation);

  const storedReports = await options.store.listReports(receiverId);
  const onChain = options.contractId ? await options.chain.getOnChainTarget(receiverId) : null;
  const reports = mergeReports(storedReports, onChain?.reports ?? []);
  const priorAuthorizations = await options.store.countAuthorizations(agentId, receiverId);

  const sources: Signals["sources"] = {
    age: snapshot.sources.age,
    activity: snapshot.sources.activity,
    code: `${snapshot.sources.code}; observation history in ${options.store.kind}`,
    keys: snapshot.sources.keys,
    history: `${options.store.kind}:interactions`,
    blocklist: onChain
      ? `${options.store.kind}:reports + near:${options.contractId}.get_target`
      : `${options.store.kind}:reports`
  };

  const policyInput: PolicyInput = {
    nowMs,
    receiverId,
    exists: snapshot.exists,
    isContract: snapshot.isContract,
    createdAtMs: snapshot.createdAtMs,
    txCount: snapshot.txCount,
    codeChangedAtMs,
    fullAccessKeyCount: snapshot.fullAccessKeyCount,
    keyPageIncomplete: snapshot.keyPageIncomplete,
    priorAuthorizations,
    reports,
    ownerConfirmed: onChain?.ownerConfirmed ?? false,
    depositYocto: input.depositYocto,
    amountYocto: input.amountYocto,
    maxPerTxYocto: options.maxPerTxYocto,
    sources
  };
  const result = decide(policyInput);
  const record: CheckRecord = {
    id: randomUUID(),
    agentId,
    receiverId,
    methodName: input.methodName,
    decision: result.decision,
    score: result.score,
    reasons: result.reasons,
    signals: result.signals,
    createdAtMs: nowMs
  };
  await options.store.saveCheck(record);
  return result;
}
