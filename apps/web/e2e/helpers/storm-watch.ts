import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { TaggedError } from "better-result";

import { DEFAULT_QUIESCENCE_LIMITS } from "@stll/render-probe/storm-ledger";

import { e2eEnv } from "./env";
import { injectedScript } from "./render-probe";
import {
  readStormWatch,
  STORM_WATCH_GLOBAL,
  type StormWatchComponent,
  type StormWatchRead,
} from "./storm-watch-contract";

// The storm watch: every page the shared fixture opens counts its React
// commits against their outside causes (./storm-watch-browser.ts), on
// development and production builds alike. At the end of each test the page
// must also go quiet. `report` (the default while the limits are
// calibrated) records the result on the test; `enforce` fails the test;
// `off` skips the watch.
type StormWatchMode = "off" | "report" | "enforce";

class RenderStormError extends TaggedError("RenderStormError")<{
  message: string;
}> {}

const stormWatchMode = (): StormWatchMode => {
  const requested = e2eEnv.stormWatch;
  return requested === "off" || requested === "enforce" ? requested : "report";
};

/** The annotation type calibration reads from Playwright's JSON report. */
export const STORM_WATCH_ANNOTATION = "storm-watch";

/** Install before the context opens its first page. */
export const installStormWatch = async (context: BrowserContext) => {
  if (stormWatchMode() === "off") {
    return;
  }
  await addStormWatch(context);
};

/** Inject the watch whatever the mode, for specs that check the watch itself. */
export const addStormWatch = async (context: BrowserContext) => {
  await context.addInitScript({ content: await injectedScript("storm-watch") });
};

const formatComponents = (components: readonly StormWatchComponent[]) =>
  components
    .map(
      ({ name, renders, causes }) =>
        `  ${name}: ${String(renders)} renders (state ${String(causes.state)}, context ${String(causes.context)}, props ${String(causes.props)}, parent ${String(causes.parent)})`,
    )
    .join("\n");

/** What makes this read a failure, as lines a test failure can show. */
export const stormWatchFailures = ({
  report,
  quiescence,
}: StormWatchRead): string[] => {
  const failures: string[] = [];
  for (const { violation, components } of report.reported) {
    failures.push(
      `render storm: ${String(violation.commitsSinceStimulus)} commits in ${String(Math.round(violation.msSinceStimulus))} ms with no input, network or message to cause them (last outside cause: ${violation.lastStimulus})\n${formatComponents(components)}`,
    );
  }
  if (quiescence.verdict === "storm") {
    failures.push(
      `the page never went ${String(DEFAULT_QUIESCENCE_LIMITS.quietMs)} ms without a commit after the test (${String(quiescence.commitsWhileWaiting)} commits in ${String(quiescence.waitedMs)} ms, nothing arriving)\n${formatComponents(quiescence.components)}`,
    );
  }
  return failures;
};

export const checkStormWatch = async (page: Page, testInfo: TestInfo) => {
  const mode = stormWatchMode();
  if (mode === "off" || page.isClosed()) {
    return;
  }
  let read: StormWatchRead | null;
  try {
    read = await page.evaluate(readStormWatch, {
      global: STORM_WATCH_GLOBAL,
      ...DEFAULT_QUIESCENCE_LIMITS,
    });
  } catch {
    // The page navigated away or closed while the watch waited: nothing to
    // read, and the test's own result stands.
    return;
  }
  if (read === null) {
    return;
  }
  const { report, quiescence } = read;
  testInfo.annotations.push({
    type: STORM_WATCH_ANNOTATION,
    description: JSON.stringify({
      commits: report.commits,
      widestTask: report.widestTask,
      lowestTokens: report.lowestTokens,
      unstimulated: report.violations.length,
      quiescence: quiescence.verdict,
      quietAfterMs: quiescence.waitedMs,
      stimuli: report.stimuli,
    }),
  });
  const failures = stormWatchFailures(read);
  if (failures.length === 0) {
    return;
  }
  await testInfo.attach("storm-watch.json", {
    body: JSON.stringify(read, null, 2),
    contentType: "application/json",
  });
  if (mode === "enforce") {
    throw new RenderStormError({ message: failures.join("\n\n") });
  }
};
