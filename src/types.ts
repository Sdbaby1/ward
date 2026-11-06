export type Decision = "allow" | "warn" | "block";

export interface Reason {
  code: string;
  detail: string;
}

export interface ReportRecord {
  reporterId: string;
  targetId: string;
  reason: string;
  evidence: string;
  confirmed: boolean;
  createdAtMs: number;
}

export interface AccountSources {
  account: string;
  age: string;
  activity: string;
  code: string;
  keys: string;
}

export interface AccountSnapshot {
  exists: boolean;
  balanceYocto: string;
  codeHash: string | null;
  isContract: boolean;
  createdAtMs: number | null;
  txCount: number | null;
  lastDeployAtMs: number | null;
  fullAccessKeyCount: number | null;
  /** True when the access-key page came back full (100 keys). The count is then a lower bound. */
  keyPageIncomplete: boolean;
  blockHeight: number | null;
  sources: AccountSources;
}

export interface OnChainTarget {
  blocked: boolean;
  ownerConfirmed: boolean;
  reportCount: number;
  reports: ReportRecord[];
}

export interface Observation {
  accountId: string;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  codeHash: string | null;
  previousCodeHash: string | null;
  codeHashChangedAtMs: number | null;
  chainCreatedAtMs: number | null;
  txCount: number | null;
  blockHeight: number | null;
  fullAccessKeys: number | null;
  source: string;
}

export interface CheckRecord {
  id: string;
  agentId: string;
  receiverId: string;
  methodName: string;
  decision: Decision;
  score: number;
  reasons: Reason[];
  signals: Signals;
  createdAtMs: number;
}

export interface Signals {
  accountAgeMs: number | null;
  txCount: number | null;
  isContract: boolean;
  exists: boolean;
  codeChangedAtMs: number | null;
  priorAuthorizations: number;
  reportCount: number;
  confirmed: boolean;
  fullAccessKeys: number | null;
  keyPageIncomplete: boolean;
  depositYocto: string;
  amountYocto: string;
  sources: {
    age: string;
    activity: string;
    code: string;
    keys: string;
    history: string;
    blocklist: string;
  };
}

export interface CheckResult {
  decision: Decision;
  score: number;
  reasons: Reason[];
  signals: Signals;
}

export class ChainUnavailable extends Error {
  readonly code = "CHAIN_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "ChainUnavailable";
  }
}
