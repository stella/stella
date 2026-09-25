/**
 * The command line of an operator run that takes each value as the argument
 * after its flag (`--limit 500`). Bad input exits the process, printing the
 * script's own usage text where the flag itself was malformed.
 */

const DECIMAL_INTEGER = /^\d+$/u;

type OperatorFlags = {
  /** The value after `--<name>`, or undefined when the flag is absent. */
  flagValue: (name: string) => string | undefined;
  /** Whether `--<name>` was passed. */
  hasFlag: (name: string) => boolean;
  /** `raw` as a positive integer, or `fallback` when it is undefined. */
  positiveInteger: (
    raw: string | undefined,
    fallback: number,
    name: string,
  ) => number;
};

export const operatorFlags = (usage: string): OperatorFlags => ({
  flagValue: (name) => {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) {
      return undefined;
    }
    const value = process.argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`--${name} requires a value`);
      console.error(usage);
      process.exit(1);
    }
    return value;
  },
  hasFlag: (name) => process.argv.includes(`--${name}`),
  positiveInteger: (raw, fallback, name) => {
    if (raw === undefined) {
      return fallback;
    }
    const parsed = DECIMAL_INTEGER.test(raw)
      ? Number.parseInt(raw, 10)
      : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      console.error(`--${name} must be a positive integer, got: ${raw}`);
      process.exit(1);
    }
    return parsed;
  },
});
