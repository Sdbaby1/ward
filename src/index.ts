import { serve } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { createApp, type AppDeps } from "./app.js";
import { RpcChainReader } from "./chain.js";
import { configFromEnv, type WardConfig } from "./config.js";
import { createDemoChain, createDemoStore } from "./fixtures.js";
import type { AgentKey } from "./guard.js";
import { createWardService } from "./service.js";
import { MemoryStore, SupabaseStore, type Store } from "./store.js";

export async function buildApp(config: WardConfig = configFromEnv()): Promise<AppDeps> {
  const now = Date.now();
  let store: Store;
  if (config.store === "supabase" && config.supabaseUrl && config.supabaseServiceRoleKey) {
    store = new SupabaseStore({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey
    });
  } else {
    store = config.demoFixtures ? await createDemoStore(now) : new MemoryStore();
  }

  const chain = config.demoFixtures
    ? createDemoChain(now)
    : new RpcChainReader({
        rpcUrl: config.rpcUrl,
        nearblocksUrl: config.nearblocksUrl,
        contractId: config.contractId
      });

  const contractId = config.demoFixtures ? config.treasuryId : config.contractId;
  const service = createWardService({
    store,
    chain,
    contractId,
    maxPerTxYocto: config.maxPerTxYocto
  });
  const agentKey: AgentKey = {
    accountId: config.agentAccountId,
    publicKey: config.agentPublicKey,
    permission: {
      type: "FunctionCall",
      receiverId: config.treasuryId,
      methodNames: ["pay"],
      allowanceYocto: config.agentAllowanceYocto
    }
  };
  return {
    service,
    store,
    network: config.network,
    treasuryId: config.treasuryId,
    contractId,
    agentKey,
    chainMode: config.demoFixtures ? "fixture" : "rpc"
  };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const deps = await buildApp();
  const app = createApp(deps);
  const config = configFromEnv();
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    process.stdout.write(`Ward listening on http://localhost:${info.port}\n`);
  });
}
