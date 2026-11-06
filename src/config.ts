import { parseYocto } from "./account.js";
import { DEMO_AGENT, DEMO_ALLOWANCE, DEMO_MAX_PER_TX, DEMO_PUBLIC_KEY, DEMO_TREASURY } from "./fixtures.js";

export interface WardConfig {
  port: number;
  store: "memory" | "supabase";
  demoFixtures: boolean;
  network: "testnet" | "mainnet";
  rpcUrl: string;
  nearblocksUrl: string;
  contractId: string | null;
  treasuryId: string;
  agentAccountId: string;
  agentPublicKey: string;
  agentAllowanceYocto: string;
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  maxPerTxYocto: string;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing ${name}. Copy .env.example and fill it in.`);
  return value;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WardConfig {
  const store = env.STORE === "supabase" ? "supabase" : "memory";
  const demoFixtures = env.DEMO_FIXTURES !== "false";
  const network = env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const rpcUrl =
    env.NEAR_RPC_URL ||
    (network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org");
  const nearblocksUrl = env.NEARBLOCKS_API_URL || "https://api.nearblocks.io";
  const contractId = env.WARD_CONTRACT_ID?.trim() || null;
  const maxPerTxYocto = env.WARD_MAX_PER_TX_YOCTO || DEMO_MAX_PER_TX;
  parseYocto(maxPerTxYocto);
  const agentAllowanceYocto = env.WARD_AGENT_ALLOWANCE_YOCTO || DEMO_ALLOWANCE;
  parseYocto(agentAllowanceYocto);

  if (!demoFixtures && !env.NEAR_RPC_URL) {
    throw new Error("DEMO_FIXTURES=false requires NEAR_RPC_URL.");
  }
  if (store === "supabase") {
    required("SUPABASE_URL", env.SUPABASE_URL);
    required("SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY);
  }

  const port = Number(env.PORT || "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }

  return {
    port,
    store,
    demoFixtures,
    network,
    rpcUrl,
    nearblocksUrl,
    contractId,
    treasuryId: env.WARD_TREASURY_CONTRACT_ID || DEMO_TREASURY,
    agentAccountId: env.WARD_AGENT_ACCOUNT_ID || DEMO_AGENT,
    agentPublicKey: env.WARD_AGENT_PUBLIC_KEY || DEMO_PUBLIC_KEY,
    agentAllowanceYocto,
    supabaseUrl: env.SUPABASE_URL || null,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || null,
    maxPerTxYocto
  };
}
