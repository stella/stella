/**
 * The command line every case-law repair takes.
 *
 * A repair reports by default and writes only under `--apply`, and it is
 * bounded by `--limit`. That contract is the same for every one of them, so it
 * is read once here rather than re-implemented per script: two scripts that
 * disagree about whether `--dry-run --apply` is an error, or about what a
 * non-numeric `--limit` does, would be two different tools wearing the same
 * flags.
 *
 * Each function exits the process on bad input after printing the caller's own
 * usage text, which is where a repair says what it repairs.
 */

const DECIMAL_INTEGER = /^\d+$/u;

/** Whether `--<name>` was passed. */
export const hasFlag = (name: string): boolean =>
  process.argv.includes(`--${name}`);

type FlagIntegerOptions = {
  /** Value when the flag is absent. */
  fallback: number;
  /** Flag name without the leading dashes. */
  name: string;
  /** Printed when the value is not a positive integer. */
  usage: string;
};

/**
 * The value an operator wrote for `--<name>`, in either spelling: the
 * separate argument the usage texts document, and the `--<name>=<value>` form
 * a shell user reaches for anyway. Both are read, because the alternative is
 * the dangerous one — an unrecognised `--limit=10` leaves the flag absent, and
 * a repair that was asked to change ten rows would change its default of
 * thousands.
 */
const flagValue = (name: string): string | undefined => {
  const inline = process.argv.find((argument) =>
    argument.startsWith(`--${name}=`),
  );
  if (inline !== undefined) {
    return inline.slice(`--${name}=`.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

/** A positive integer flag, or its fallback. */
export const flagInteger = ({
  fallback,
  name,
  usage,
}: FlagIntegerOptions): number => {
  const raw = flagValue(name);
  if (raw === undefined && !hasFlag(name)) {
    return fallback;
  }
  const parsed =
    raw !== undefined && DECIMAL_INTEGER.test(raw)
      ? Number.parseInt(raw, 10)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(
      `--${name} must be a positive integer, got: ${raw ?? "(none)"}`,
    );
    console.error(usage);
    process.exit(1);
  }
  return parsed;
};

/** Flags every repair takes, so a caller lists only its own. */
const SHARED_FLAGS = ["apply", "dry-run"] as const;

/**
 * Refuse a flag this repair does not have.
 *
 * Silence is the dangerous reading: an operator repeating a command a script
 * used to document — a flag that scoped a run to one source, or resumed it
 * from a cursor — would otherwise be told nothing and get a run over a wider
 * population than they asked for. What a repair does not understand it must
 * not accept, so an unrecognised `--flag` stops the run before it takes a lane
 * or writes anything.
 *
 * Values are not flags: only arguments opening with `--` are inspected, in
 * both the separate and the `--flag=value` spelling.
 */
export const rejectUnknownFlags = ({
  known,
  usage,
}: {
  known: readonly string[];
  usage: string;
}): void => {
  const recognised = new Set<string>([...SHARED_FLAGS, ...known]);
  const unknown = process.argv
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => argument.slice(2).split("=")[0] ?? "")
    .filter((name) => !recognised.has(name));
  if (unknown.length === 0) {
    return;
  }
  console.error(
    `This repair has no ${unknown.map((name) => `--${name}`).join(", ")}.`,
  );
  console.error(usage);
  process.exit(1);
};

/**
 * Whether this run writes. `--dry-run` is the default and is accepted so it
 * cannot be mistaken for a flag the script ignores; stating both is an error
 * rather than a silent preference for one of them.
 */
export const readApplyFlag = (usage: string): boolean => {
  const apply = hasFlag("apply");
  if (apply && hasFlag("dry-run")) {
    console.error("--apply and --dry-run contradict each other; pass one.");
    console.error(usage);
    process.exit(1);
  }
  return apply;
};
