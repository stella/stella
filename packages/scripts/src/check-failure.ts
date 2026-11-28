type CheckFailureBase = {
  readonly check: string;
  readonly summary: string;
  readonly details?: readonly string[];
  readonly rerunCommand?: string;
};

/**
 * Structured check failure that requires either a mechanical `fixCommand` or
 * explicit human `remediation` at the type level.
 */
export type CheckFailure =
  | (CheckFailureBase & {
      readonly fixCommand: string;
      readonly remediation?: string;
    })
  | (CheckFailureBase & {
      readonly remediation: string;
      readonly fixCommand?: undefined;
    });

/** Format a check failure into a uniform, machine-parseable remediation block. */
export const formatCheckFailure = (failure: CheckFailure): string => {
  const lines = [`[${failure.check}] ${failure.summary}`];
  if (failure.details !== undefined) {
    for (const detail of failure.details) {
      lines.push(`  - ${detail}`);
    }
  }
  if (failure.fixCommand !== undefined) {
    lines.push(`Fix: ${failure.fixCommand}`);
  }
  if (failure.remediation !== undefined) {
    lines.push(`Remediation: ${failure.remediation}`);
  }
  if (failure.rerunCommand !== undefined) {
    lines.push(`Re-run: ${failure.rerunCommand}`);
  }
  return lines.join("\n");
};

type FailCheckOptions = {
  readonly write?: (text: string) => void;
  readonly exitCode?: number;
};

/** Write a structured check failure to stderr and return the failing exit code. */
export const failCheck = (
  failure: CheckFailure,
  {
    write = (text) => {
      process.stderr.write(text);
    },
    exitCode = 1,
  }: FailCheckOptions = {},
): number => {
  write(`${formatCheckFailure(failure)}\n`);
  return exitCode;
};
