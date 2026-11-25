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
  const watch: unknown = Reflect.get(globalThis, global);
  if (
    typeof watch !== "object" ||
    watch === null ||
    !("report" in watch) ||
    typeof watch.report !== "function" ||
    !("waitQuiet" in watch) ||
    typeof watch.waitQuiet !== "function"
  ) {
    return null;
  }
  const quiescence: StormWatchQuiescence = await watch.waitQuiet(
    quietMs,
    timeoutMs,
  );
  const report: StormWatchReport = watch.report();
  return { report, quiescence };
};
