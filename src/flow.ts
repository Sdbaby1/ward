import type { Decision } from "./types.js";

/**
 * The payment wrapper's phases. Score math and key checks stay outside this table.
 * `next` is the only legal step for an agent.
 */
export type GuardOutcome = "stopped" | "human_rejected" | "signed";

export type PayPhase = "clear" | "awaiting_human" | "signed" | "rejected" | "stopped";

export type NextAction = "pay" | "ask_human" | "stop" | "retry" | "none";

export interface FlowStep {
  phase: PayPhase;
  next: NextAction;
}

export function guardTransition(input: {
  checkFailed: boolean;
  decision?: Decision;
  humanApproved?: boolean;
}): { outcome: GuardOutcome; signed: boolean } {
  if (input.checkFailed || input.decision === undefined) {
    return { outcome: "stopped", signed: false };
  }
  if (input.decision === "block") {
    return { outcome: "stopped", signed: false };
  }
  if (input.decision === "warn" && input.humanApproved !== true) {
    return { outcome: "human_rejected", signed: false };
  }
  return { outcome: "signed", signed: true };
}

export function stepFromDecision(decision: Decision): FlowStep {
  if (decision === "allow") return { phase: "clear", next: "pay" };
  if (decision === "warn") return { phase: "awaiting_human", next: "ask_human" };
  return { phase: "stopped", next: "stop" };
}

export function stepFromGuard(input: {
  outcome: GuardOutcome;
  check: { decision: Decision } | null;
}): FlowStep {
  if (input.outcome === "signed") return { phase: "signed", next: "none" };
  if (input.outcome === "human_rejected") return { phase: "rejected", next: "stop" };
  if (input.check === null) return { phase: "stopped", next: "retry" };
  return stepFromDecision(input.check.decision);
}
