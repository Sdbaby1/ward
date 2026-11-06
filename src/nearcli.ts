export function jsonArg(value: unknown): string {
  return JSON.stringify(value);
}

export function deployCommand(options: {
  contractId: string;
  wasmPath: string;
  init: Record<string, string>;
  network: "testnet" | "mainnet";
}): string {
  return [
    "near contract deploy",
    options.contractId,
    "use-file",
    options.wasmPath,
    "with-init-call new",
    "json-args",
    `'${jsonArg(options.init)}'`,
    "prepaid-gas '30 Tgas'",
    "attached-deposit '0 NEAR'",
    "network-config",
    options.network,
    "sign-with-keychain send"
  ].join(" ");
}

export function addFunctionCallKeyCommand(options: {
  accountId: string;
  contractId: string;
  allowanceNear: string;
  network: "testnet" | "mainnet";
}): string {
  return [
    "near account add-key",
    options.accountId,
    "grant-function-call-access",
    `--allowance '${options.allowanceNear} NEAR'`,
    `--contract-account-id ${options.contractId}`,
    "--function-names pay",
    "autogenerate-new-keypair save-to-keychain",
    "network-config",
    options.network,
    "sign-with-keychain send"
  ].join(" ");
}

export function payCommand(options: {
  contractId: string;
  signerId: string;
  counterparty: string;
  amountYocto: string;
  network: "testnet" | "mainnet";
}): string {
  const args = jsonArg({
    receiver: options.counterparty,
    amount: options.amountYocto
  });
  return [
    "near contract call-function as-transaction",
    options.contractId,
    "pay",
    "json-args",
    `'${args}'`,
    "prepaid-gas '30 Tgas'",
    "attached-deposit '0 NEAR'",
    "sign-as",
    options.signerId,
    "network-config",
    options.network,
    "sign-with-keychain send"
  ].join(" ");
}

export function reportCommand(options: {
  contractId: string;
  signerId: string;
  targetId: string;
  reason: string;
  evidence: string;
  network: "testnet" | "mainnet";
}): string {
  const args = jsonArg({
    target: options.targetId,
    reason: options.reason,
    evidence: options.evidence
  });
  return [
    "near contract call-function as-transaction",
    options.contractId,
    "report",
    "json-args",
    `'${args}'`,
    "prepaid-gas '30 Tgas'",
    "attached-deposit '0.05 NEAR'",
    "sign-as",
    options.signerId,
    "network-config",
    options.network,
    "sign-with-keychain send"
  ].join(" ");
}

export function readTargetCommand(options: {
  contractId: string;
  targetId: string;
  network: "testnet" | "mainnet";
}): string {
  return [
    "near contract call-function as-read-only",
    options.contractId,
    "get_target",
    "json-args",
    `'${jsonArg({ target: options.targetId })}'`,
    "network-config",
    options.network,
    "now"
  ].join(" ");
}
