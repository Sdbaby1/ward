import { isEmptyCodeHash, isImplicitAccount, parseYocto } from "./account.js";
import type { CheckResult, Decision, Reason, Signals } from "./types.js";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const REPORT_BLOCK_THRESHOLD = 3;
export const YOUNG_ACCOUNT_MS = DAY_MS;
export const NEW_ACCOUNT_MS = 7 * DAY_MS;
export const CODE_CHANGE_WINDOW_MS = 2 * DAY_MS;
export const LOW_ACTIVITY_TX = 5;
export const BLOCK_SCORE = 70;
export const WARN_SCORE = 35;

export interface PolicyInput {
  nowMs: number;
  receiverId: string;
  exists: boolean;
  isContract: boolean;
  createdAtMs: number | null;
  txCount: number | null;
  codeChangedAtMs: number | null;
  fullAccessKeyCount: number | null;
  keyPageIncomplete: boolean;
  priorAuthorizations: number;
  reports: { reporterId: string; evidence: string; reason: string; confirmed: boolean }[];
  ownerConfirmed: boolean;
  depositYocto: string;
  amountYocto: string;
  maxPerTxYocto: string;
  sources: Signals["sources"];
}

function push(reasons: Reason[], code: string, detail: string): void {
  reasons.push({ code, detail });
}

/**
 * Deterministic counterparty score. Higher is worse.
 * Block wins over warn. Missing indexer data cannot produce an allow.
 * A missing account, a confirmed report, or three evidence-backed reports always block.
 */
export function decide(input: PolicyInput): CheckResult {
  parseYocto(input.depositYocto);
  parseYocto(input.amountYocto);
  parseYocto(input.maxPerTxYocto);

  const reasons: Reason[] = [];
  let score = 0;
  let forceBlock = false;
  let forceWarn = false;

  const distinctReporters = new Set(input.reports.map((report) => report.reporterId));
  const reportCount = distinctReporters.size;
  const sample = input.reports.find((report) => report.confirmed) ?? input.reports[0];
  const confirmed = input.ownerConfirmed || input.reports.some((report) => report.confirmed);

  if (confirmed) {
    forceBlock = true;
    score += 100;
    push(
      reasons,
      "BLOCKLIST_CONFIRMED",
      sample
        ? `Confirmed shared blocklist report by ${sample.reporterId}. Evidence: ${sample.evidence}`
        : "Receiver is on the owner-confirmed blocklist."
    );
  }

  if (!input.exists) {
    forceBlock = true;
    score += 90;
    push(reasons, "ACCOUNT_MISSING", "Receiver account does not exist on this network.");
  }

  const implicit = isImplicitAccount(input.receiverId);
  if (
    input.exists &&
    implicit &&
    input.priorAuthorizations === 0 &&
    (input.txCount === null || input.txCount === 0)
  ) {
    forceBlock = true;
    score += 80;
    push(
      reasons,
      "IMPLICIT_NO_HISTORY",
      "First payment to an implicit account with no transaction history."
    );
  }

  if (!confirmed && reportCount >= REPORT_BLOCK_THRESHOLD) {
    forceBlock = true;
    score += 80;
    push(
      reasons,
      "REPORT_THRESHOLD",
      `${reportCount} independent evidence-backed reports. The contract rejects pay() at ${REPORT_BLOCK_THRESHOLD}.`
    );
  } else if (!confirmed && reportCount > 0) {
    forceWarn = true;
    score += 40;
    push(
      reasons,
      "REPORTS_PRESENT",
      `${reportCount} evidence-backed report${reportCount === 1 ? "" : "s"}, below the block threshold of ${REPORT_BLOCK_THRESHOLD}.`
    );
  }

  let accountAgeMs: number | null = null;
  if (input.exists && input.createdAtMs !== null) {
    accountAgeMs = Math.max(0, input.nowMs - input.createdAtMs);
    if (accountAgeMs < YOUNG_ACCOUNT_MS) {
      forceWarn = true;
      score += 35;
      push(reasons, "ACCOUNT_AGE_UNDER_DAY", "Receiver account was created less than 24 hours ago.");
    } else if (accountAgeMs < NEW_ACCOUNT_MS) {
      forceWarn = true;
      score += 20;
      push(reasons, "ACCOUNT_AGE_UNDER_WEEK", "Receiver account was created less than 7 days ago.");
    }
  } else if (input.exists) {
    forceWarn = true;
    score += 25;
    push(
      reasons,
      "ACCOUNT_AGE_UNKNOWN",
      "Account age could not be read. Ward does not allow a payment without an age."
    );
  }

  if (
    input.exists &&
    input.isContract &&
    input.codeChangedAtMs !== null &&
    input.nowMs - input.codeChangedAtMs >= 0 &&
    input.nowMs - input.codeChangedAtMs < CODE_CHANGE_WINDOW_MS
  ) {
    forceWarn = true;
    score += 35;
    push(
      reasons,
      "CODE_CHANGED_RECENTLY",
      "Contract code changed within the last 48 hours."
    );
  }

  if (input.exists && !input.isContract) {
    score += 10;
    push(reasons, "NO_CONTRACT_CODE", "Receiver has no contract code. code_hash is the empty hash.");
  }

  if (input.priorAuthorizations > 0) {
    score -= 25;
    push(
      reasons,
      "PRIOR_INTERACTION",
      `This agent has ${input.priorAuthorizations} earlier authorization${input.priorAuthorizations === 1 ? "" : "s"} for this receiver.`
    );
  } else {
    score += 15;
    push(reasons, "FIRST_INTERACTION", "This agent has never been authorized to pay this receiver.");
  }

  if (input.txCount === 0) {
    forceWarn = true;
    score += 20;
    push(reasons, "LOW_ACTIVITY", "Indexer reports zero transactions for this receiver.");
  } else if (input.txCount !== null && input.txCount < LOW_ACTIVITY_TX) {
    score += 10;
    push(reasons, "LOW_ACTIVITY", `Indexer reports only ${input.txCount} transaction${input.txCount === 1 ? "" : "s"}.`);
  }

  if (input.isContract && input.keyPageIncomplete) {
    forceWarn = true;
    score += 15;
    push(
      reasons,
      "KEY_PAGE_INCOMPLETE",
      "view_access_key_list returned a full page of 100 keys, so a full-access key may be on a later page."
    );
  } else if (
    input.isContract &&
    input.fullAccessKeyCount !== null &&
    input.fullAccessKeyCount > 0
  ) {
    forceWarn = true;
    score += 20;
    push(
      reasons,
      "CONTRACT_HAS_FULL_ACCESS_KEY",
      "This contract account still has a full-access key, so its code and funds can be changed outside the contract."
    );
  }

  if (input.depositYocto !== "0") {
    forceWarn = true;
    score += 30;
    push(
      reasons,
      "ATTACHED_DEPOSIT",
      "The intent attaches NEAR. A function-call key cannot attach tokens, and the wrapper will not sign it."
    );
  }

  if (BigInt(input.amountYocto) > BigInt(input.maxPerTxYocto)) {
    forceBlock = true;
    score += 70;
    push(
      reasons,
      "AMOUNT_OVER_MAX",
      "Amount is above the treasury max per transaction. pay() would reject it."
    );
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let decision: Decision;
  if (forceBlock || score >= BLOCK_SCORE) {
    decision = "block";
  } else if (forceWarn || score >= WARN_SCORE) {
    decision = "warn";
  } else {
    decision = "allow";
  }

  const signals: Signals = {
    accountAgeMs,
    txCount: input.txCount,
    isContract: input.isContract,
    exists: input.exists,
    codeChangedAtMs: input.codeChangedAtMs,
    priorAuthorizations: input.priorAuthorizations,
    reportCount,
    confirmed,
    fullAccessKeys: input.fullAccessKeyCount,
    keyPageIncomplete: input.keyPageIncomplete,
    depositYocto: input.depositYocto,
    amountYocto: input.amountYocto,
    sources: input.sources
  };

  return { decision, score, reasons, signals };
}

export function contractFromCodeHash(codeHash: string | null): boolean {
  return !isEmptyCodeHash(codeHash);
}
