import { EMPTY_CODE_HASH, isEmptyCodeHash } from "./account.js";
import { ChainUnavailable, type AccountSnapshot, type OnChainTarget, type ReportRecord } from "./types.js";

const RPC_TIMEOUT_MS = 4_000;

export interface ChainReader {
  getAccount(accountId: string): Promise<AccountSnapshot>;
  getOnChainTarget(accountId: string): Promise<OnChainTarget | null>;
}

export interface RpcChainOptions {
  rpcUrl: string;
  nearblocksUrl: string;
  contractId: string | null;
  fetchImpl?: typeof fetch;
}

interface RpcErrorBody {
  error?: { message?: string; data?: unknown; cause?: { name?: string } };
  result?: unknown;
}

export class RpcChainReader implements ChainReader {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RpcChainOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getAccount(accountId: string): Promise<AccountSnapshot> {
    const account = await this.viewAccount(accountId);
    if (!account.exists) {
      return missingSnapshot(accountId, "rpc:query view_account");
    }

    const [age, activity, deploy, keys] = await Promise.all([
      this.readAge(accountId),
      this.readTxCount(accountId),
      this.readLastDeploy(accountId),
      this.readKeys(accountId)
    ]);

    return {
      exists: true,
      balanceYocto: account.balanceYocto,
      codeHash: account.codeHash,
      isContract: !isEmptyCodeHash(account.codeHash),
      createdAtMs: age.createdAtMs,
      txCount: activity.txCount,
      lastDeployAtMs: deploy.lastDeployAtMs,
      fullAccessKeyCount: keys.fullAccessKeyCount,
      keyPageIncomplete: keys.keyPageIncomplete,
      blockHeight: account.blockHeight,
      sources: {
        account: "rpc:query view_account",
        age: age.source,
        activity: activity.source,
        code: deploy.source,
        keys: keys.source
      }
    };
  }

  async getOnChainTarget(accountId: string): Promise<OnChainTarget | null> {
    if (!this.options.contractId) return null;
    const args = Buffer.from(JSON.stringify({ target: accountId }), "utf8").toString("base64");
    const result = await this.rpc("query", {
      request_type: "call_function",
      finality: "final",
      account_id: this.options.contractId,
      method_name: "get_target",
      args_base64: args
    });
    const payload = decodeCallResult(result);
    return parseTarget(payload);
  }

  private async viewAccount(accountId: string): Promise<{
    exists: boolean;
    balanceYocto: string;
    codeHash: string | null;
    blockHeight: number | null;
  }> {
    try {
      const result = await this.rpc("query", {
        request_type: "view_account",
        finality: "final",
        account_id: accountId
      });
      const row = asRecord(result);
      return {
        exists: true,
        balanceYocto: String(row.amount ?? "0"),
        codeHash: typeof row.code_hash === "string" ? row.code_hash : EMPTY_CODE_HASH,
        blockHeight: typeof row.block_height === "number" ? row.block_height : null
      };
    } catch (error) {
      if (error instanceof MissingAccount) {
        return { exists: false, balanceYocto: "0", codeHash: null, blockHeight: null };
      }
      throw error;
    }
  }

  private async readAge(accountId: string): Promise<{ createdAtMs: number | null; source: string }> {
    try {
      const body = await this.nearblocks(`/v1/account/${encodeURIComponent(accountId)}`);
      const created = body.account?.[0]?.created?.block_timestamp;
      if (typeof created === "number" || typeof created === "string") {
        return {
          createdAtMs: nanosecondsToMs(created),
          source: "nearblocks:/v1/account created.block_timestamp"
        };
      }
      return { createdAtMs: null, source: "nearblocks:/v1/account (no created timestamp)" };
    } catch {
      return { createdAtMs: null, source: "nearblocks:/v1/account unavailable" };
    }
  }

  private async readTxCount(accountId: string): Promise<{ txCount: number | null; source: string }> {
    try {
      const body = await this.nearblocks(`/v1/account/${encodeURIComponent(accountId)}/txns/count`);
      const count = body.txns?.[0]?.count;
      if (typeof count === "string" || typeof count === "number") {
        return {
          txCount: Number(count),
          source: "nearblocks:/v1/account/{id}/txns/count"
        };
      }
      return { txCount: null, source: "nearblocks:/v1/account/{id}/txns/count (no count)" };
    } catch {
      return { txCount: null, source: "nearblocks:/v1/account/{id}/txns/count unavailable" };
    }
  }

  private async readLastDeploy(accountId: string): Promise<{ lastDeployAtMs: number | null; source: string }> {
    try {
      const body = await this.nearblocks(
        `/v1/account/${encodeURIComponent(accountId)}/receipts?per_page=25&order=desc`
      );
      const receipts = Array.isArray(body.receipts) ? body.receipts : [];
      let latest: number | null = null;
      for (const receipt of receipts) {
        if (!receiptHasDeploy(receipt)) continue;
        const stamp = receiptTimestampMs(receipt);
        if (stamp !== null && (latest === null || stamp > latest)) latest = stamp;
      }
      return {
        lastDeployAtMs: latest,
        source:
          latest === null
            ? "nearblocks receipts page had no DEPLOY_CONTRACT; observation history is the other source"
            : "nearblocks:/v1/account/{id}/receipts DEPLOY_CONTRACT"
      };
    } catch {
      return {
        lastDeployAtMs: null,
        source: "nearblocks receipts unavailable; observation history is the code-change source"
      };
    }
  }

  private async readKeys(accountId: string): Promise<{
    fullAccessKeyCount: number | null;
    keyPageIncomplete: boolean;
    source: string;
  }> {
    try {
      const result = await this.rpc("query", {
        request_type: "view_access_key_list",
        finality: "final",
        account_id: accountId,
        limit: 100
      });
      const row = asRecord(result);
      const keys = Array.isArray(row.keys) ? row.keys : [];
      let fullAccess = 0;
      for (const key of keys) {
        if (isFullAccess(asRecord(asRecord(key).access_key).permission)) fullAccess += 1;
      }
      return {
        fullAccessKeyCount: fullAccess,
        keyPageIncomplete: keys.length >= 100,
        source: "rpc:query view_access_key_list limit=100"
      };
    } catch {
      return {
        fullAccessKeyCount: null,
        keyPageIncomplete: false,
        source: "rpc:query view_access_key_list unavailable"
      };
    }
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "ward", method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
      });
    } catch (error) {
      throw new ChainUnavailable(`NEAR RPC request failed: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      throw new ChainUnavailable(`NEAR RPC HTTP ${response.status}`);
    }
    const body = (await response.json()) as RpcErrorBody;
    if (body.error) {
      const text = `${body.error.message ?? ""} ${stringifyData(body.error.data)} ${body.error.cause?.name ?? ""}`;
      if (/does not exist|doesn't exist|unknown_account|UNKNOWN_ACCOUNT/i.test(text)) {
        throw new MissingAccount(text);
      }
      throw new ChainUnavailable(`NEAR RPC error: ${text.slice(0, 300)}`);
    }
    return body.result;
  }

  private async nearblocks(path: string): Promise<NearblocksBody> {
    const root = this.options.nearblocksUrl.replace(/\/+$/, "");
    let response: Response;
    try {
      response = await this.fetchImpl(`${root}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
      });
    } catch (error) {
      throw new Error(errorMessage(error));
    }
    if (!response.ok) throw new Error(`NearBlocks HTTP ${response.status}`);
    return (await response.json()) as NearblocksBody;
  }
}

class MissingAccount extends Error {}

interface NearblocksBody {
  account?: { created?: { block_timestamp?: number | string | null } | null }[];
  txns?: { count?: number | string }[];
  receipts?: unknown[];
}

function missingSnapshot(accountId: string, source: string): AccountSnapshot {
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
      account: source,
      age: "not queried because the account does not exist",
      activity: "not queried because the account does not exist",
      code: "not queried because the account does not exist",
      keys: "not queried because the account does not exist"
    }
  };
}

export function nanosecondsToMs(value: number | string | bigint): number {
  return Number(BigInt(value) / 1_000_000n);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringifyData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === undefined) return "";
  try {
    return JSON.stringify(data);
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFullAccess(permission: unknown): boolean {
  if (permission === "FullAccess") return true;
  if (!permission || typeof permission !== "object") return false;
  const record = permission as Record<string, unknown>;
  return "FullAccess" in record || "GasKeyFullAccess" in record;
}

function receiptHasDeploy(receipt: unknown): boolean {
  const row = asRecord(receipt);
  const actions = Array.isArray(row.actions) ? row.actions : [];
  return actions.some((action) => {
    const name = actionName(action);
    return name === "DEPLOY_CONTRACT" || name === "DeployContract" || name === "deploy_contract";
  });
}

function actionName(action: unknown): string {
  if (typeof action === "string") return action;
  const row = asRecord(action);
  if (typeof row.action === "string") return row.action;
  if (typeof row.action_kind === "string") return row.action_kind;
  return "";
}

function receiptTimestampMs(receipt: unknown): number | null {
  const row = asRecord(receipt);
  const block = asRecord(row.receipt_block);
  const raw =
    block.block_timestamp ??
    row.block_timestamp ??
    asRecord(row.outcome).block_timestamp ??
    null;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const numeric = BigInt(raw);
  if (numeric > 1_000_000_000_000_000n) return nanosecondsToMs(numeric);
  if (numeric > 1_000_000_000_000n) return Number(numeric);
  return Number(numeric) * 1000;
}

function decodeCallResult(result: unknown): unknown {
  const row = asRecord(result);
  const raw = row.result;
  if (typeof raw === "string") {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  }
  if (Array.isArray(raw)) {
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  }
  return raw;
}

function parseTarget(payload: unknown): OnChainTarget {
  const row = asRecord(payload);
  const reportsRaw = Array.isArray(row.reports) ? row.reports : [];
  const reports: ReportRecord[] = reportsRaw.map((item) => {
    const report = asRecord(item);
    return {
      reporterId: String(report.reporter ?? ""),
      targetId: String(report.target ?? ""),
      reason: String(report.reason ?? ""),
      evidence: String(report.evidence ?? ""),
      confirmed: Boolean(report.confirmed),
      createdAtMs: Number(report.created_at_ms ?? 0)
    };
  });
  return {
    blocked: Boolean(row.blocked),
    ownerConfirmed: Boolean(row.owner_confirmed),
    reportCount: Number(row.report_count ?? reports.length),
    reports
  };
}

export function mergeReports(left: ReportRecord[], right: ReportRecord[]): ReportRecord[] {
  const byReporter = new Map<string, ReportRecord>();
  for (const report of [...left, ...right]) {
    if (!report.reporterId) continue;
    const previous = byReporter.get(report.reporterId);
    if (!previous) {
      byReporter.set(report.reporterId, report);
      continue;
    }
    byReporter.set(report.reporterId, {
      ...report,
      confirmed: previous.confirmed || report.confirmed
    });
  }
  return [...byReporter.values()];
}
