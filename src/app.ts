import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { normalizeAccountId } from "./account.js";
import { runAttackDemo } from "./demo/attack.js";
import { isEvidence, isReason } from "./evidence.js";
import type { AgentKey } from "./guard.js";
import { guardedPay, RecordingSigner } from "./guard.js";
import { payCommand, reportCommand } from "./nearcli.js";
import type { WardService } from "./service.js";
import type { Store } from "./store.js";
import { ChainUnavailable } from "./types.js";

export interface AppDeps {
  service: WardService;
  store: Store;
  network: "testnet" | "mainnet";
  treasuryId: string;
  contractId: string | null;
  agentKey: AgentKey;
  chainMode: "fixture" | "rpc";
  now?: () => number;
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");

const files: Record<string, { type: string; body: string }> = {
  "/": { type: "text/html; charset=utf-8", body: readFileSync(path.join(webRoot, "index.html"), "utf8") },
  "/styles.css": { type: "text/css; charset=utf-8", body: readFileSync(path.join(webRoot, "styles.css"), "utf8") },
  "/app.js": { type: "text/javascript; charset=utf-8", body: readFileSync(path.join(webRoot, "app.js"), "utf8") },
  "/favicon.svg": { type: "image/svg+xml", body: readFileSync(path.join(webRoot, "favicon.svg"), "utf8") }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    await next();
  });

  for (const [route, file] of Object.entries(files)) {
    app.get(route, (c) => c.body(file.body, 200, { "content-type": file.type }));
  }

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      store: deps.store.kind,
      chain: deps.chainMode,
      network: deps.network,
      contractId: deps.contractId
    })
  );

  app.post("/api/v1/check", async (c) => {
    const body = await readBody(c);
    if (!body.ok) return c.json(body, 400);
    try {
      const result = await deps.service.evaluate(
        {
          agentId: stringField(body.value, "agentId"),
          receiverId: stringField(body.value, "receiverId"),
          methodName: stringField(body.value, "methodName", "pay"),
          depositYocto: stringField(body.value, "depositYocto", "0"),
          amountYocto: stringField(body.value, "amountYocto", "1000000000000000000000000")
        },
        deps.now ? deps.now() : Date.now()
      );
      return c.json(result);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/api/v1/checks", async (c) => {
    const agentId = c.req.query("agent");
    if (!agentId) return c.json({ error: "agent query is required" }, 400);
    try {
      const checks = await deps.store.listChecks(normalizeAccountId(agentId), 20);
      return c.json({ checks });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/api/v1/reports", async (c) => {
    const reports = await deps.store.listRecentReports(50);
    return c.json({ reports });
  });

  app.post("/api/v1/reports", async (c) => {
    const body = await readBody(c);
    if (!body.ok) return c.json(body, 400);
    try {
      const reporterId = normalizeAccountId(stringField(body.value, "reporterId"));
      const targetId = normalizeAccountId(stringField(body.value, "targetId"));
      const reason = stringField(body.value, "reason").trim();
      const evidence = stringField(body.value, "evidence").trim();
      if (!isReason(reason)) {
        return c.json({ error: "Reason must be 8 to 280 characters." }, 400);
      }
      if (!isEvidence(evidence)) {
        return c.json(
          { error: "Evidence must be 32 to 500 characters and start with tx: or https://." },
          400
        );
      }
      if (reporterId === targetId) {
        return c.json({ error: "A reporter cannot report itself." }, 400);
      }
      const now = deps.now ? deps.now() : Date.now();
      await deps.store.upsertReport({
        reporterId,
        targetId,
        reason,
        evidence,
        confirmed: false,
        createdAtMs: now
      });
      const command = deps.contractId
        ? reportCommand({
            contractId: deps.contractId,
            signerId: reporterId,
            targetId,
            reason,
            evidence,
            network: deps.network
          })
        : null;
      return c.json({
        stored: true,
        confirmed: false,
        note: "This endpoint cannot confirm a report. Confirmation happens on the Ward contract, which the agent key cannot call.",
        nearCli: command
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/v1/pay", async (c) => {
    const body = await readBody(c);
    if (!body.ok) return c.json(body, 400);
    try {
      const counterparty = stringField(body.value, "counterparty");
      const amountYocto = stringField(body.value, "amountYocto");
      const humanApproved = body.value.humanApproved === true;
      const memo = typeof body.value.memo === "string" ? body.value.memo.slice(0, 200) : undefined;
      const signer = new RecordingSigner();
      let asked = false;
      const result = await guardedPay({
        key: deps.agentKey,
        treasuryId: deps.treasuryId,
        intent: {
          receiverId: deps.treasuryId,
          methodName: "pay",
          depositYocto: "0",
          args: { counterparty, amountYocto, ...(memo ? { memo } : {}) }
        },
        checker: {
          check: (input) => deps.service.evaluate(input, deps.now ? deps.now() : Date.now())
        },
        signer,
        askHuman: async () => {
          asked = true;
          return humanApproved;
        }
      });
      if (result.outcome === "signed") {
        await deps.store.recordInteraction({
          agentId: deps.agentKey.accountId,
          receiverId: normalizeAccountId(counterparty),
          methodName: "pay",
          decision: result.check?.decision === "warn" ? "warn" : "allow",
          humanApproved,
          createdAtMs: deps.now ? deps.now() : Date.now()
        });
      }
      const status = result.outcome === "signed" ? 200 : result.outcome === "human_rejected" ? 409 : 403;
      return c.json(
        {
          outcome: result.outcome,
          signed: result.signed,
          askedHuman: asked,
          detail: result.detail,
          check: result.check,
          nearCli:
            result.signed
              ? payCommand({
                  contractId: deps.treasuryId,
                  signerId: deps.agentKey.accountId,
                  counterparty: normalizeAccountId(counterparty),
                  amountYocto,
                  network: deps.network
                })
              : null
        },
        status
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/v1/demo/attack", async (c) => {
    const demo = await runAttackDemo(deps.now ? deps.now() : Date.now());
    return c.json({ log: demo.log, signedCount: demo.signedCount });
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string }
> {
  try {
    const value = await c.req.json();
    if (!isRecord(value)) return { ok: false, error: "JSON object required." };
    return { ok: true, value };
  } catch {
    return { ok: false, error: "JSON object required." };
  }
}

function stringField(body: Record<string, unknown>, name: string, fallback?: string): string {
  const value = body[name];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}.`);
}

function failure(c: { json: (body: unknown, status?: number) => Response }, error: unknown): Response {
  const message = error instanceof Error ? error.message : "Request failed.";
  const chainDown =
    error instanceof ChainUnavailable ||
    (error instanceof Error && error.name === "ChainUnavailable") ||
    /CHAIN_UNAVAILABLE|NEAR RPC/.test(message);
  return c.json({ error: message }, chainDown ? 503 : 400);
}
