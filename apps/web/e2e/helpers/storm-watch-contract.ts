import type { ComponentRenders } from "@stll/render-probe";
import type {
  StormLedgerReport,
  StormViolation,
} from "@stll/render-probe/storm-ledger";

/** Where the page exposes the storm watch to the test driver. */
export const STORM_WATCH_GLOBAL = "__STLL_STORM_WATCH__";

export type StormWatchComponent = ComponentRenders & { name: string };

export type StormWatchViolationReport = {
  violation: StormViolation;
  /** The components rendered since the last outside stimulus, most first. */
  components: StormWatchComponent[];
};

export type StormWatchQuiescence = {
  /**
   * `quiet`: the page went a quiet stretch without a commit. `busy`: it kept
   * committing while something outside the app kept arriving. `storm`: it
   * kept committing with nothing arriving.
   */
  verdict: "quiet" | "busy" | "storm";
  waitedMs: number;
  commitsWhileWaiting: number;
  components: StormWatchComponent[];
};

export type StormWatchReport = StormLedgerReport & {
  reported: StormWatchViolationReport[];
};

export type StormWatchState = {
  report: () => StormWatchReport;
  waitQuiet: (
    quietMs: number,
    timeoutMs: number,
  ) => Promise<StormWatchQuiescence>;
};

export type StormWatchRead = {
  report: StormWatchReport;
  quiescence: StormWatchQuiescence;
};

// Playwright serializes this function without its module scope: the global's
// name is passed in, and the checks stay inside.
export const readStormWatch = async ({
  global,
  quietMs,
  timeoutMs,
}: {
  global: string;
  quietMs: number;
  timeoutMs: number;
}): Promise<StormWatchRead | null> => {
  const isStormWatchState = (value: unknown): value is StormWatchState =>
    typeof value === "object" &&
    value !== null &&
    "report" in value &&
    typeof value.report === "function" &&
    "waitQuiet" in value &&
    typeof value.waitQuiet === "function";
  const watch: unknown = Reflect.get(globalThis, global);
  if (!isStormWatchState(watch)) {
    return null;
  }
  const quiescence = await watch.waitQuiet(quietMs, timeoutMs);
  return { report: watch.report(), quiescence };
};
