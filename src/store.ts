import type { CheckRecord, Observation, ReportRecord } from "./types.js";

export interface InteractionRecord {
  agentId: string;
  receiverId: string;
  methodName: string;
  decision: "allow" | "warn";
  humanApproved: boolean;
  createdAtMs: number;
}

export interface Store {
  readonly kind: "memory" | "supabase";
  getObservation(accountId: string): Promise<Observation | null>;
  saveObservation(observation: Observation): Promise<void>;
  countAuthorizations(agentId: string, receiverId: string): Promise<number>;
  recordInteraction(interaction: InteractionRecord): Promise<void>;
  saveCheck(check: CheckRecord): Promise<void>;
  listChecks(agentId: string, limit: number): Promise<CheckRecord[]>;
  upsertReport(report: ReportRecord): Promise<void>;
  listReports(targetId: string): Promise<ReportRecord[]>;
  listRecentReports(limit: number): Promise<ReportRecord[]>;
}

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private readonly observations = new Map<string, Observation>();
  private readonly interactions: InteractionRecord[] = [];
  private readonly checks: CheckRecord[] = [];
  private readonly reports = new Map<string, ReportRecord>();

  async getObservation(accountId: string): Promise<Observation | null> {
    return this.observations.get(accountId) ?? null;
  }

  async saveObservation(observation: Observation): Promise<void> {
    this.observations.set(observation.accountId, observation);
  }

  async countAuthorizations(agentId: string, receiverId: string): Promise<number> {
    return this.interactions.filter(
      (row) => row.agentId === agentId && row.receiverId === receiverId
    ).length;
  }

  async recordInteraction(interaction: InteractionRecord): Promise<void> {
    this.interactions.push(interaction);
  }

  async saveCheck(check: CheckRecord): Promise<void> {
    this.checks.push(check);
  }

  async listChecks(agentId: string, limit: number): Promise<CheckRecord[]> {
    return this.checks
      .filter((check) => check.agentId === agentId)
      .slice()
      .reverse()
      .slice(0, limit);
  }

  async upsertReport(report: ReportRecord): Promise<void> {
    const key = `${report.reporterId}:${report.targetId}`;
    const previous = this.reports.get(key);
    this.reports.set(key, previous ? { ...report, confirmed: previous.confirmed || report.confirmed } : report);
  }

  async listReports(targetId: string): Promise<ReportRecord[]> {
    return [...this.reports.values()].filter((report) => report.targetId === targetId);
  }

  async listRecentReports(limit: number): Promise<ReportRecord[]> {
    return [...this.reports.values()]
      .slice()
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, limit);
  }
}

interface SupabaseOptions {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}

function reportKey(report: ReportRecord): string {
  return `${report.reporterId}:${report.targetId}`;
}

export class SupabaseStore implements Store {
  readonly kind = "supabase" as const;
  private readonly rest: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: SupabaseOptions) {
    const base = options.url.replace(/\/+$/, "");
    this.rest = `${base}/rest/v1`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = {
      apikey: options.serviceRoleKey,
      authorization: `Bearer ${options.serviceRoleKey}`,
      "content-type": "application/json"
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(`${this.rest}${path}`, {
      ...init,
      headers: { ...this.headers, ...(init.headers ?? {}) }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supabase ${response.status} on ${path}: ${body.slice(0, 300)}`);
    }
    return response;
  }

  async getObservation(accountId: string): Promise<Observation | null> {
    const response = await this.request(
      `/observations?account_id=eq.${encodeURIComponent(accountId)}&select=*`,
      { method: "GET" }
    );
    const rows = (await response.json()) as ObservationRow[];
    const row = rows[0];
    return row ? fromObservation(row) : null;
  }

  async saveObservation(observation: Observation): Promise<void> {
    await this.request("/observations?on_conflict=account_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(toObservation(observation))
    });
  }

  async countAuthorizations(agentId: string, receiverId: string): Promise<number> {
    const response = await this.request(
      `/interactions?agent_id=eq.${encodeURIComponent(agentId)}&receiver_id=eq.${encodeURIComponent(receiverId)}&select=id`,
      {
        method: "GET",
        headers: { prefer: "count=exact" }
      }
    );
    const range = response.headers.get("content-range");
    if (range && range.includes("/")) {
      const total = range.split("/")[1];
      if (total && total !== "*") return Number(total);
    }
    const rows = (await response.json()) as unknown[];
    return rows.length;
  }

  async recordInteraction(interaction: InteractionRecord): Promise<void> {
    await this.request("/interactions", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        agent_id: interaction.agentId,
        receiver_id: interaction.receiverId,
        method_name: interaction.methodName,
        decision: interaction.decision,
        human_approved: interaction.humanApproved,
        created_at: new Date(interaction.createdAtMs).toISOString()
      })
    });
  }

  async saveCheck(check: CheckRecord): Promise<void> {
    await this.request("/checks", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        id: check.id,
        agent_id: check.agentId,
        receiver_id: check.receiverId,
        method_name: check.methodName,
        decision: check.decision,
        score: check.score,
        reasons: check.reasons,
        signals: check.signals,
        created_at: new Date(check.createdAtMs).toISOString()
      })
    });
  }

  async listChecks(agentId: string, limit: number): Promise<CheckRecord[]> {
    const response = await this.request(
      `/checks?agent_id=eq.${encodeURIComponent(agentId)}&select=*&order=created_at.desc&limit=${limit}`,
      { method: "GET" }
    );
    const rows = (await response.json()) as CheckRow[];
    return rows.map(fromCheck);
  }

  async upsertReport(report: ReportRecord): Promise<void> {
    const existing = (await this.listReports(report.targetId)).find(
      (row) => row.reporterId === report.reporterId
    );
    const confirmed = Boolean(existing?.confirmed || report.confirmed);
    await this.request("/reports?on_conflict=reporter_account_id,target_account_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(toReport({ ...report, confirmed }))
    });
  }

  async listReports(targetId: string): Promise<ReportRecord[]> {
    const response = await this.request(
      `/reports?target_account_id=eq.${encodeURIComponent(targetId)}&select=*`,
      { method: "GET" }
    );
    const rows = (await response.json()) as ReportRow[];
    return rows.map(fromReport);
  }

  async listRecentReports(limit: number): Promise<ReportRecord[]> {
    const response = await this.request(
      `/reports?select=*&order=created_at.desc&limit=${limit}`,
      { method: "GET" }
    );
    const rows = (await response.json()) as ReportRow[];
    return rows.map(fromReport);
  }
}

interface ObservationRow {
  account_id: string;
  first_seen_at: string;
  last_seen_at: string;
  code_hash: string | null;
  previous_code_hash: string | null;
  code_hash_changed_at: string | null;
  chain_created_at: string | null;
  tx_count: number | null;
  block_height: number | null;
  full_access_keys: number | null;
  source: string;
}

interface CheckRow {
  id: string;
  agent_id: string;
  receiver_id: string;
  method_name: string;
  decision: CheckRecord["decision"];
  score: number;
  reasons: CheckRecord["reasons"];
  signals: CheckRecord["signals"];
  created_at: string;
}

interface ReportRow {
  reporter_account_id: string;
  target_account_id: string;
  reason: string;
  evidence: string;
  confirmed: boolean;
  created_at: string;
}

function toObservation(observation: Observation): Record<string, unknown> {
  return {
    account_id: observation.accountId,
    first_seen_at: new Date(observation.firstSeenAtMs).toISOString(),
    last_seen_at: new Date(observation.lastSeenAtMs).toISOString(),
    code_hash: observation.codeHash,
    previous_code_hash: observation.previousCodeHash,
    code_hash_changed_at: observation.codeHashChangedAtMs
      ? new Date(observation.codeHashChangedAtMs).toISOString()
      : null,
    chain_created_at: observation.chainCreatedAtMs
      ? new Date(observation.chainCreatedAtMs).toISOString()
      : null,
    tx_count: observation.txCount,
    block_height: observation.blockHeight,
    full_access_keys: observation.fullAccessKeys,
    source: observation.source
  };
}

function fromObservation(row: ObservationRow): Observation {
  return {
    accountId: row.account_id,
    firstSeenAtMs: Date.parse(row.first_seen_at),
    lastSeenAtMs: Date.parse(row.last_seen_at),
    codeHash: row.code_hash,
    previousCodeHash: row.previous_code_hash,
    codeHashChangedAtMs: row.code_hash_changed_at ? Date.parse(row.code_hash_changed_at) : null,
    chainCreatedAtMs: row.chain_created_at ? Date.parse(row.chain_created_at) : null,
    txCount: row.tx_count,
    blockHeight: row.block_height,
    fullAccessKeys: row.full_access_keys,
    source: row.source
  };
}

function fromCheck(row: CheckRow): CheckRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    receiverId: row.receiver_id,
    methodName: row.method_name,
    decision: row.decision,
    score: row.score,
    reasons: row.reasons,
    signals: row.signals,
    createdAtMs: Date.parse(row.created_at)
  };
}

function toReport(report: ReportRecord): Record<string, unknown> {
  return {
    reporter_account_id: report.reporterId,
    target_account_id: report.targetId,
    reason: report.reason,
    evidence: report.evidence,
    confirmed: report.confirmed,
    created_at: new Date(report.createdAtMs).toISOString()
  };
}

function fromReport(row: ReportRow): ReportRecord {
  return {
    reporterId: row.reporter_account_id,
    targetId: row.target_account_id,
    reason: row.reason,
    evidence: row.evidence,
    confirmed: row.confirmed,
    createdAtMs: Date.parse(row.created_at)
  };
}

export { reportKey };
