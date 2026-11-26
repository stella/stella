import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { TaggedError } from "better-result";

import { DEFAULT_QUIESCENCE_LIMITS } from "@stll/render-probe/storm-ledger";

import { e2eEnv } from "./env";
import { injectedScript } from "./render-probe";
import {
  readStormWatch,
  STORM_WATCH_BINDING,
  STORM_WATCH_GLOBAL,
  type StormWatchComponent,
  type StormWatchQuiescence,
  type StormWatchRead,
  type StormWatchViolationReport,
} from "./storm-watch-contract";

// The storm watch: every page the shared fixture opens counts its React
// commits against their outside causes (./storm-watch-browser.ts), on
// development and production builds alike. At the end of each test the page
// must also go quiet. `enforce` (the default) fails the test; `report`
// only records the result on it, for calibrating the limits; `off` skips the
// watch. The result is recorded on every test either way.
type StormWatchMode = "off" | "report" | "enforce";

class RenderStormError extends TaggedError("RenderStormError")<{
  message: string;
}> {}

const stormWatchMode = (): StormWatchMode => {
  const requested = e2eEnv.stormWatch;
  return requested === "off" || requested === "report" ? requested : "enforce";
};

/** The annotation type calibration reads from Playwright's JSON report. */
export const STORM_WATCH_ANNOTATION = "storm-watch";

// Reports each page forwarded while the test ran, kept per context so a page
// the test closed before its end is still checked.
const forwardedReports = new WeakMap<
  BrowserContext,
  Map<Page, StormWatchViolationReport[]>
>();

const isViolationReport = (
  value: unknown,
): value is StormWatchViolationReport =>
  typeof value === "object" &&
  value !== null &&
  "violation" in value &&
  "components" in value &&
  Array.isArray(value.components);

/** Install before the context opens its first page. */
export const installStormWatch = async (context: BrowserContext) => {
  if (stormWatchMode() === "off") {
    return;
  }
  await addStormWatch(context);
};

/** Inject the watch whatever the mode, for specs that check the watch itself. */
export const addStormWatch = async (context: BrowserContext) => {
  const forwarded = new Map<Page, StormWatchViolationReport[]>();
  forwardedReports.set(context, forwarded);
  await context.exposeBinding(
    STORM_WATCH_BINDING,
    ({ page }: { page: Page }, report: unknown) => {
      if (isViolationReport(report)) {
        forwarded.set(page, [...(forwarded.get(page) ?? []), report]);
      }
    },
  );
  await context.addInitScript({ content: await injectedScript("storm-watch") });
};

const formatComponents = (components: readonly StormWatchComponent[]) =>
  components
    .map(
      ({ name, renders, causes }) =>
        `  ${name}: ${String(renders)} renders (state ${String(causes.state)}, context ${String(causes.context)}, props ${String(causes.props)}, parent ${String(causes.parent)})`,
    )
    .join("\n");

const violationFailure = ({
  violation,
  components,
}: StormWatchViolationReport) =>
  `render storm: ${String(violation.commitsSinceStimulus)} commits in ${String(Math.round(violation.msSinceStimulus))} ms with no input, network or message to cause them (last outside cause: ${violation.lastStimulus})\n${formatComponents(components)}`;

const quiescenceFailures = ({
  verdict,
  commitsWhileWaiting,
  waitedMs,
  components,
}: StormWatchQuiescence): string[] =>
  verdict === "storm"
    ? [
        `the page never went ${String(DEFAULT_QUIESCENCE_LIMITS.quietMs)} ms without a commit after the test (${String(commitsWhileWaiting)} commits in ${String(waitedMs)} ms, nothing arriving)\n${formatComponents(components)}`,
      ]
    : [];

/** What makes this read a failure, as lines a test failure can show. */
export const stormWatchFailures = ({
  report,
  quiescence,
}: StormWatchRead): string[] => [
  ...report.reported.map(violationFailure),
  ...quiescenceFailures(quiescence),
];

type PageCheck = {
  annotation: Record<string, unknown>;
  failures: string[];
  evidence: unknown;
};

// The page's reports: every one it forwarded, from each document it has
// shown, and any of the current document's own that did not arrive. The
// binding delivers copies, so they are matched by content.
const unstimulatedReports = (
  forwarded: readonly StormWatchViolationReport[],
  current: readonly StormWatchViolationReport[],
) => {
  const seen = new Set(forwarded.map((report) => JSON.stringify(report)));
  return [
    ...forwarded,
    ...current.filter((report) => !seen.has(JSON.stringify(report))),
  ];
};

// An open page is read whole and must go quiet; a closed one only has the
// reports it forwarded while it lived. Forwarded reports are read after the
// wait, so one that arrives during it still counts.
const checkPage = async (
  page: Page,
  readForwarded: () => readonly StormWatchViolationReport[],
): Promise<PageCheck | null> => {
  let read: StormWatchRead | null = null;
  const closed = page.isClosed();
  if (!closed) {
    try {
      read = await page.evaluate(readStormWatch, {
        global: STORM_WATCH_GLOBAL,
        ...DEFAULT_QUIESCENCE_LIMITS,
      });
    } catch {
      // The page navigated away or closed while the watch waited: its
      // forwarded reports are all there is.
    }
  }
  const unstimulated = unstimulatedReports(
    readForwarded(),
    read?.report.reported ?? [],
  );
  if (read === null) {
    return unstimulated.length === 0
      ? null
      : {
          annotation: { closed, unstimulated: unstimulated.length },
          failures: unstimulated.map(violationFailure),
          evidence: unstimulated,
        };
  }
  const { report, quiescence } = read;
  return {
    annotation: {
      commits: report.commits,
      widestTask: report.widestTask,
      lowestTokens: report.lowestTokens,
      unstimulated: Math.max(report.violations.length, unstimulated.length),
      quiescence: quiescence.verdict,
      quietAfterMs: quiescence.waitedMs,
      stimuli: report.stimuli,
    },
    failures: [
      ...unstimulated.map(violationFailure),
      ...quiescenceFailures(quiescence),
    ],
    evidence: { ...read, forwarded: unstimulated },
  };
};

export type StormWatchPageCheck = PageCheck & {
  /** The test's own page is 0, others follow in the order they opened. */
  page: number;
};

/**
 * Check every page the context opened: the test's own page first, then any
 * opened beside it, open or already closed.
 */
export const stormWatchChecks = async (
  context: BrowserContext,
  page: Page | null,
): Promise<StormWatchPageCheck[]> => {
  const forwarded =
    forwardedReports.get(context) ??
    new Map<Page, StormWatchViolationReport[]>();
  const pages = [
    ...new Set([
      ...(page === null ? [] : [page]),
      ...context.pages(),
      ...forwarded.keys(),
    ]),
  ];
  const checks: StormWatchPageCheck[] = [];
  for (const [index, checked] of pages.entries()) {
    const result = await checkPage(checked, () => forwarded.get(checked) ?? []);
    if (result !== null) {
      checks.push({ page: index, ...result });
    }
  }
  return checks;
};

/** Record every page's result on the test; fail it in `enforce` mode. */
export const checkStormWatch = async (
  context: BrowserContext,
  page: Page | null,
  testInfo: TestInfo,
) => {
  const mode = stormWatchMode();
  if (mode === "off") {
    return;
  }
  const failures: string[] = [];
  for (const check of await stormWatchChecks(context, page)) {
    testInfo.annotations.push({
      type: STORM_WATCH_ANNOTATION,
      description: JSON.stringify({ page: check.page, ...check.annotation }),
    });
    if (check.failures.length === 0) {
      continue;
    }
    failures.push(
      ...check.failures.map(
        (failure) => `page ${String(check.page)}: ${failure}`,
      ),
    );
    await testInfo.attach(`storm-watch-page-${String(check.page)}.json`, {
      body: JSON.stringify(check.evidence, null, 2),
      contentType: "application/json",
    });
  }
  if (mode === "enforce" && failures.length > 0) {
    throw new RenderStormError({ message: failures.join("\n\n") });
  }
};
