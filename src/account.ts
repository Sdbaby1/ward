const NAMED_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** 32 zero bytes, base58. NEAR uses this code hash for an account with no contract. */
export const EMPTY_CODE_HASH = "11111111111111111111111111111111";

export class AccountIdError extends Error {
  readonly code = "ACCOUNT_ID";

  constructor(value: string) {
    super(`Invalid NEAR account id: ${value}`);
    this.name = "AccountIdError";
  }
}

export function isImplicitAccount(accountId: string): boolean {
  return /^[0-9a-f]{64}$/.test(accountId);
}

export function isValidAccountId(accountId: string): boolean {
  return accountId.length >= 2 && accountId.length <= 64 && NAMED_ACCOUNT.test(accountId);
}

export function normalizeAccountId(value: string): string {
  const accountId = value.trim().toLowerCase();
  if (!isValidAccountId(accountId)) {
    throw new AccountIdError(value);
  }
  return accountId;
}

export function isEmptyCodeHash(codeHash: string | null): boolean {
  return codeHash === null || codeHash === EMPTY_CODE_HASH;
}

/** Canonical yoctoNEAR integer. Rejects signs, decimals, and leading zeros. */
export function parseYocto(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid yoctoNEAR amount: ${value}`);
  }
  return BigInt(value);
}

export const YOCTO_PER_NEAR = 10n ** 24n;

export function formatNear(yocto: string): string {
  const value = parseYocto(yocto);
  const whole = value / YOCTO_PER_NEAR;
  const frac = (value % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac.length === 0 ? `${whole} NEAR` : `${whole}.${frac} NEAR`;
}
