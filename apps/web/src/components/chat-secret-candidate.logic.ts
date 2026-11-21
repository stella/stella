const CREDENTIAL_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{24,}\b/u,
  /\bAIza[0-9A-Za-z_-]{30,}\b/u,
] as const;

export const containsCredentialCandidate = (text: string): boolean =>
  CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
