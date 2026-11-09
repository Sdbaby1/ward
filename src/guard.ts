import { formatNear, isValidAccountId, parseYocto } from "./account.js";
import { guardTransition } from "./flow.js";
import type { CheckResult } from "./types.js";

export class KeyScopeError extends Error {
  readonly code = "KEY_SCOPE";

  constructor(message: string) {
    super(message);
    this.name = "KeyScopeError";
  }
}

export interface FunctionCallPermission {
  type: "FunctionCall";
  receiverId: string;
  methodNames: string[];
  allowanceYocto: string;
}

export interface FullAccessPermission {
  type: "FullAccess";
}

export interface AgentKey {
  accountId: string;
  publicKey: string;
  permission: FunctionCallPermission | FullAccessPermission;
}

export interface PaymentIntent {
  receiverId: string;
  methodName: string;
  depositYocto: string;
  args: {
    counterparty: string;
    amountYocto: string;
    memo?: string;
  };
}

export interface Signer {
  sign(intent: PaymentIntent): Promise<{ signature: string }>;
}

export interface Checker {
  check(input: {
    agentId: string;
    receiverId: string;
    methodName: string;
    depositYocto: string;
    amountYocto: string;
  }): Promise<CheckResult>;
}

export type GuardOutcome = "stopped" | "human_rejected" | "signed";

export interface GuardResult {
  outcome: GuardOutcome;
  signed: boolean;
  check: CheckResult | null;
  signature: string | null;
  detail: string;
}

/**
 * The agent key may sign one method on one contract.
 * It is not a full-access key, it cannot attach NEAR, and its gas allowance is finite.
 * The counterparty inside the pay arguments is checked before sign() is called.
 */
export function assertCanSign(key: AgentKey, intent: PaymentIntent, treasuryId: string): void {
  if (!isValidAccountId(key.accountId)) {
    throw new KeyScopeError("Agent account id is not a valid NEAR account.");
  }
  if (!key.publicKey.startsWith("ed25519:")) {
    throw new KeyScopeError("Ward only accepts an ed25519 function-call key.");
  }
  if (key.permission.type !== "FunctionCall") {
    throw new KeyScopeError("Refusing to sign with a full-access key.");
  }
  if (key.permission.receiverId !== treasuryId) {
    throw new KeyScopeError(
      `Key receiver_id is ${key.permission.receiverId}. The agent key must be scoped to ${treasuryId}.`
    );
  }
  if (key.permission.methodNames.length !== 1 || key.permission.methodNames[0] !== "pay") {
    throw new KeyScopeError("The agent key must allow exactly one method: pay.");
  }
  const allowance = parseYocto(key.permission.allowanceYocto);
  if (allowance <= 0n) {
    throw new KeyScopeError(
      "Key allowance is 0. Every transaction would fail with NotEnoughAllowance, and a zero allowance cannot be topped up."
    );
  }
  if (intent.receiverId !== key.permission.receiverId) {
    throw new KeyScopeError(
      `Function-call key can only call ${key.permission.receiverId}, not ${intent.receiverId}.`
    );
  }
  if (intent.methodName !== "pay") {
    throw new KeyScopeError(`Function-call key cannot call ${intent.methodName}.`);
  }
  if (intent.depositYocto !== "0") {
    throw new KeyScopeError(
      "Function-call keys cannot attach NEAR. Deposit must be 0. The treasury spends its own balance."
    );
  }
  if (!isValidAccountId(intent.args.counterparty)) {
    throw new KeyScopeError("Counterparty is not a valid NEAR account id.");
  }
  parseYocto(intent.args.amountYocto);
}

export function describeKey(key: AgentKey): string[] {
  if (key.permission.type !== "FunctionCall") {
    return [
      "key: FullAccess",
      "can transfer NEAR: yes",
      "can add keys: yes",
      "Ward refuses this key."
    ];
  }
  return [
    "key: FunctionCall",
    `  receiver_id: ${key.permission.receiverId}`,
    `  method_names: ${JSON.stringify(key.permission.methodNames)}`,
    `  allowance: ${formatNear(key.permission.allowanceYocto)} (gas only)`,
    "  can attach NEAR: no",
    "  can transfer NEAR directly: no",
    "  can add or delete keys: no",
    "  can deploy code: no",
    "  can call any other contract: no"
  ];
}

export async function guardedPay(options: {
  key: AgentKey;
  treasuryId: string;
  intent: PaymentIntent;
  checker: Checker;
  signer: Signer;
  askHuman: (check: CheckResult) => Promise<boolean>;
}): Promise<GuardResult> {
  assertCanSign(options.key, options.intent, options.treasuryId);
  let check: CheckResult;
  try {
    check = await options.checker.check({
      agentId: options.key.accountId,
      receiverId: options.intent.args.counterparty,
      methodName: options.intent.methodName,
      depositYocto: options.intent.depositYocto,
      amountYocto: options.intent.args.amountYocto
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const transition = guardTransition({ checkFailed: true });
    return {
      outcome: transition.outcome,
      signed: transition.signed,
      check: null,
      signature: null,
      detail: `Chain or policy check failed closed: ${message}`
    };
  }

  const humanApproved = check.decision === "warn" ? await options.askHuman(check) : false;
  const transition = guardTransition({
    checkFailed: false,
    decision: check.decision,
    humanApproved
  });
  if (!transition.signed) {
    return {
      outcome: transition.outcome,
      signed: false,
      check,
      signature: null,
      detail:
        transition.outcome === "human_rejected"
          ? "A human rejected the warning. The signer was not called."
          : "Ward returned block. The signer was not called."
    };
  }

  const signed = await options.signer.sign(options.intent);
  return {
    outcome: transition.outcome,
    signed: true,
    check,
    signature: signed.signature,
    detail: check.decision === "warn" ? "Signed after a human approved the warning." : "Signed."
  };
}

export class RecordingSigner implements Signer {
  readonly signed: PaymentIntent[] = [];

  async sign(intent: PaymentIntent): Promise<{ signature: string }> {
    this.signed.push(intent);
    return { signature: `ed25519:recorded-${this.signed.length}` };
  }
}
