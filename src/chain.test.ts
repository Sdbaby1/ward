import { describe, expect, it } from "vitest";
import { nanosecondsToMs, RpcChainReader } from "./chain.js";

const ACCOUNT = "wrap.near";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

describe("RpcChainReader", () => {
  it("reads age, activity, code hash, keys, and an on-chain target", async () => {
    const target = {
      blocked: true,
      owner_confirmed: true,
      report_count: 1,
      reports: [
        {
          reporter: "sentinel.near",
          target: "known-bad.near",
          reason: "drain",
          evidence: "tx:demo9f3c0a7b1e8d4c2a6b5f0e1d9c8a7b6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b",
          confirmed: true,
          created_at_ms: 1
        }
      ]
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("nearblocks") && url.endsWith("/txns/count")) {
        return jsonResponse({ txns: [{ count: "42" }] });
      }
      if (url.includes("nearblocks") && url.includes("/receipts")) {
        return jsonResponse({
          receipts: [
            {
              receipt_block: { block_timestamp: "1700000000000000000" },
              actions: [{ action: "DEPLOY_CONTRACT" }]
            }
          ]
        });
      }
      if (url.includes("nearblocks")) {
        return jsonResponse({
          account: [{ created: { block_timestamp: 1613398225524785200 }, amount: "1" }]
        });
      }
      const body = JSON.parse(String(init?.body));
      if (body.params.request_type === "view_account") {
        if (body.params.account_id === "missing.near") {
          return jsonResponse({
            error: { message: "Server error", data: "account missing.near doesn't exist" }
          });
        }
        return jsonResponse({
          result: {
            amount: "5",
            code_hash: "4DmerchantCodeHashDemo1111111111111111111111111111",
            block_height: 10,
            locked: "0",
            storage_usage: 182
          }
        });
      }
      if (body.params.request_type === "view_access_key_list") {
        return jsonResponse({
          result: {
            keys: [
              { public_key: "ed25519:one", access_key: { nonce: 1, permission: "FullAccess" } },
              {
                public_key: "ed25519:two",
                access_key: {
                  nonce: 2,
                  permission: { FunctionCall: { allowance: "1", receiver_id: "treasury.near", method_names: ["pay"] } }
                }
              }
            ]
          }
        });
      }
      if (body.params.method_name === "get_target") {
        return jsonResponse({ result: { result: Array.from(Buffer.from(JSON.stringify(target))) } });
      }
      return jsonResponse({ error: { message: "unexpected" } }, 200);
    };

    const reader = new RpcChainReader({
      rpcUrl: "https://rpc.testnet.near.org",
      nearblocksUrl: "https://api.nearblocks.io",
      contractId: "ward.testnet",
      fetchImpl
    });
    const account = await reader.getAccount(ACCOUNT);
    expect(account.exists).toBe(true);
    expect(account.isContract).toBe(true);
    expect(account.txCount).toBe(42);
    expect(account.createdAtMs).toBe(nanosecondsToMs(1613398225524785200));
    expect(account.lastDeployAtMs).toBe(nanosecondsToMs("1700000000000000000"));
    expect(account.fullAccessKeyCount).toBe(1);
    expect(account.sources.age).toContain("nearblocks");

    const missing = await reader.getAccount("missing.near");
    expect(missing.exists).toBe(false);

    const onChain = await reader.getOnChainTarget("known-bad.near");
    expect(onChain?.ownerConfirmed).toBe(true);
    expect(onChain?.reports[0]?.reporterId).toBe("sentinel.near");
  });

  it("fails closed when the RPC cannot be reached", async () => {
    const reader = new RpcChainReader({
      rpcUrl: "https://rpc.testnet.near.org",
      nearblocksUrl: "https://api.nearblocks.io",
      contractId: null,
      fetchImpl: async () => {
        throw new Error("offline");
      }
    });
    await expect(reader.getAccount("wrap.near")).rejects.toThrow(/failed closed|NEAR RPC request failed|offline/);
  });
});
