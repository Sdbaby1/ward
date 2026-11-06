import { describe, expect, it } from "vitest";
import { configFromEnv } from "./config.js";

describe("configFromEnv", () => {
  it("defaults to demo fixtures and memory", () => {
    const config = configFromEnv({});
    expect(config.demoFixtures).toBe(true);
    expect(config.store).toBe("memory");
    expect(config.network).toBe("testnet");
    expect(config.rpcUrl).toBe("https://rpc.testnet.near.org");
  });

  it("refuses a live mode without an RPC URL", () => {
    expect(() => configFromEnv({ DEMO_FIXTURES: "false", NEAR_RPC_URL: "" })).toThrow(/NEAR_RPC_URL/);
  });

  it("requires Supabase credentials when the store is supabase", () => {
    expect(() => configFromEnv({ STORE: "supabase" })).toThrow(/SUPABASE_URL/);
  });
});
