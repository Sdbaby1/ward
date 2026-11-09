import { describe, expect, it } from "vitest";
import { guardTransition, stepFromDecision, stepFromGuard } from "./flow.js";

describe("payment flow", () => {
  it("stops when the check fails or the decision is block", () => {
    expect(guardTransition({ checkFailed: true })).toEqual({ outcome: "stopped", signed: false });
    expect(guardTransition({ checkFailed: false, decision: "block", humanApproved: true })).toEqual({
      outcome: "stopped",
      signed: false
    });
  });

  it("signs an allow without a person, and a warn only after approval", () => {
    expect(guardTransition({ checkFailed: false, decision: "allow", humanApproved: false })).toEqual({
      outcome: "signed",
      signed: true
    });
    expect(guardTransition({ checkFailed: false, decision: "warn", humanApproved: false })).toEqual({
      outcome: "human_rejected",
      signed: false
    });
    expect(guardTransition({ checkFailed: false, decision: "warn" })).toEqual({
      outcome: "human_rejected",
      signed: false
    });
    expect(guardTransition({ checkFailed: false, decision: "warn", humanApproved: true })).toEqual({
      outcome: "signed",
      signed: true
    });
  });

  it("tells an agent the one legal next step", () => {
    expect(stepFromDecision("allow")).toEqual({ phase: "clear", next: "pay" });
    expect(stepFromDecision("warn")).toEqual({ phase: "awaiting_human", next: "ask_human" });
    expect(stepFromDecision("block")).toEqual({ phase: "stopped", next: "stop" });
    expect(stepFromGuard({ outcome: "signed", check: { decision: "allow" } })).toEqual({
      phase: "signed",
      next: "none"
    });
    expect(stepFromGuard({ outcome: "human_rejected", check: { decision: "warn" } })).toEqual({
      phase: "rejected",
      next: "stop"
    });
    expect(stepFromGuard({ outcome: "stopped", check: null })).toEqual({
      phase: "stopped",
      next: "retry"
    });
    expect(stepFromGuard({ outcome: "stopped", check: { decision: "block" } })).toEqual({
      phase: "stopped",
      next: "stop"
    });
  });
});
