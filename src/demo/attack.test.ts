import { describe, expect, it } from "vitest";
import { runAttackDemo } from "./attack.js";

describe("attack demo", () => {
  it("stops the injected payment and still signs the merchant", async () => {
    const result = await runAttackDemo(Date.UTC(2026, 10, 6, 12, 0, 0));
    const lines = result.log.split("\n");
    expect(lines).toContain("  result: PAYMENT STOPPED");
    expect(lines).toContain("  signer.called: false");
    expect(result.log).toContain("BLOCKLIST_CONFIRMED");
    expect(result.log).toContain("Function-call key can only call treasury.ward.testnet, not known-bad.ward.testnet.");
    expect(lines).toContain("  result: SIGNED AFTER HUMAN APPROVAL");
    expect(lines).toContain("  result: SIGNED");
    expect(result.log).toContain("CODE_CHANGED_RECENTLY");
    expect(result.signedCount).toBe(2);
    const stoppedAt = result.log.indexOf("result: PAYMENT STOPPED");
    const signedAt = result.log.indexOf("result: SIGNED AFTER HUMAN APPROVAL");
    expect(stoppedAt).toBeGreaterThan(-1);
    expect(stoppedAt).toBeLessThan(signedAt);
  });
});
