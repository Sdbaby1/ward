export function isEvidence(value: string): boolean {
  return (
    value.length >= 32 &&
    value.length <= 500 &&
    (value.startsWith("tx:") || value.startsWith("https://"))
  );
}

export function isReason(value: string): boolean {
  return value.trim().length >= 8 && value.trim().length <= 280;
}
