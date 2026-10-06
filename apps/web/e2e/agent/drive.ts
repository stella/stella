// The e2e tsconfig is node-only; page.evaluate / addInitScript callbacks run
// in the browser.
/// <reference lib="dom" />
import { chromium } from "@playwright/test";
// Drive the running web app as the seeded owner and write evidence: a
// screenshot, the browser errors, the failed API calls and, for `measure`,
// timing and network numbers. Run only through `bun run agent:drive`, which
// points it at this checkout's seeded stack (`bun run agent:up`) and records
// where every screenshot came from, so `agent:attach` can refuse any image
// that could show non-fixture data.
//
// Exit code 1 means the page itself showed a problem (browser error, 5xx,
// sign-in redirect, route error boundary); the report says which.
import type { Browser, BrowserContext, Page, Response } from "@playwright/test";
import { panic } from "better-result";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import { ROUTE_ERROR_HEADING } from "../helpers/app-shell";
import { createNetworkCollector, summarizeCapture } from "../helpers/network";
import { createBrowserErrorCollector } from "../helpers/test";
import {
  formatFindings,
  formatSummaryTable,
  hasBlockingFindings,
  isMeasureSummary,
  pageTotals,
  parseDriveArgs,
  summarizeSamples,
  type DriveOptions,
  type MeasureSample,
  type PageFindings,
} from "./drive-report";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const STORAGE_STATE = path.join(REPO_ROOT, ".playwright/storage-state.json");
const EVIDENCE_DIR = path.join(REPO_ROOT, ".stella-dev/evidence");
const MEASUREMENTS_DIR = path.join(REPO_ROOT, ".stella-dev/measurements");
// No fallbacks: a default URL would point at whatever stack happens to run on
// it, including one holding real data.
const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(
      `${name} is not set; run this through \`bun run agent:drive\``,
    );
    process.exit(2);
  }
  return value;
};
const WEB_URL = requiredEnv("E2E_WEB_URL");
const API_URL = requiredEnv("E2E_API_URL");
// One JSON line per screenshot; agent-session.ts turns it into the manifest.
const CAPTURE_LOG = requiredEnv("STELLA_AGENT_CAPTURE_LOG");
const API_ORIGIN = new URL(API_URL).origin;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BLOCKED_REQUEST_ERROR = /net::ERR_BLOCKED_BY_CLIENT/u;
// Matches route-smoke: API quiet for 500 ms after at least one second.
const QUIET = { idleMs: 500, minimumObservationMs: 1000, timeoutMs: 20_000 };
const READY_TIMEOUT_MS = 30_000;
const LCP_GLOBAL = "__stellaAgentLcp";
// @stll/ui Skeleton; a route still showing one inside main has not rendered.
const LOADING_PLACEHOLDER = 'main [data-slot="skeleton"]';

// Origins the driver refused to contact, reported so a missing avatar or font
// in a screenshot is explained.
const blockedRequests = new Set<string>();

// Unsaved input never reaches the database, so the seal cannot see a typed
// value; any text entered into a page taints every later capture of that
// browser context. The page flag covers the current document, the binding
// carries the taint across navigations.
const TEXT_ENTRY_BINDING = "__stellaAgentTextEntered";
const TEXT_ENTRY_EVENTS = ["input", "paste", "drop"];
const textEnteredContexts = new WeakSet<BrowserContext>();

type Session = {
  browser: Browser;
  newContext: () => Promise<BrowserContext>;
};

const openSession = async (options: DriveOptions): Promise<Session> => {
  if (!existsSync(STORAGE_STATE)) {
    throw new Error(
      `${STORAGE_STATE} is missing; run \`bun run agent:up\` first`,
    );
  }
  const browser = await chromium.launch();
  return {
    browser,
    newContext: async () => {
      const context = await browser.newContext({
        baseURL: WEB_URL,
        colorScheme: options.colorScheme,
        storageState: STORAGE_STATE,
        viewport: options.viewport,
      });
      // Only the local stack is reachable, so no screenshot can show another
      // site or a signed-in outside service.
      await context.route("**/*", async (route) => {
        const { hostname } = new URL(route.request().url());
        if (LOCAL_HOSTNAMES.has(hostname)) {
          await route.continue();
          return;
        }
        blockedRequests.add(new URL(route.request().url()).origin);
        await route.abort("blockedbyclient");
      });
      await context.exposeBinding(TEXT_ENTRY_BINDING, () => {
        textEnteredContexts.add(context);
      });
      await context.addInitScript(
        ({ binding, events }) => {
          for (const type of events) {
            window.addEventListener(
              type,
              () => {
                Reflect.set(window, `${binding}Flag`, true);
                const notify: unknown = Reflect.get(window, binding);
                if (typeof notify === "function") {
                  Reflect.apply(notify, window, []);
                }
              },
              { capture: true },
            );
          }
        },
        { binding: TEXT_ENTRY_BINDING, events: TEXT_ENTRY_EVENTS },
      );
      return context;
    },
  };
};

type CaptureOptions = {
  fullPage: boolean;
  label: string;
  page: Page;
  screenshotPath: string;
};

const capture = async ({
  fullPage,
  label,
  page,
  screenshotPath,
}: CaptureOptions) => {
  const image = await page.screenshot({ fullPage, path: screenshotPath });
  const textEntered =
    textEnteredContexts.has(page.context()) ||
    (await page.evaluate(
      (flag) => Reflect.get(window, flag) === true,
      `${TEXT_ENTRY_BINDING}Flag`,
    ));
  await appendFile(
    CAPTURE_LOG,
    `${JSON.stringify({
      label,
      // Real path, matching the one agent:attach resolves, so a symlinked
      // checkout path cannot make a genuine capture look unrecorded.
      path: realpathSync(screenshotPath),
      sha256: hashSha256Hex(image),
      textEntered,
      url: page.url(),
    })}\n`,
  );
};

type TrackedPage = {
  finish: () => Promise<PageFindings>;
  network: ReturnType<typeof createNetworkCollector>;
  page: Page;
};

const trackPage = async (context: BrowserContext): Promise<TrackedPage> => {
  const page = await context.newPage();
  const browserErrors = createBrowserErrorCollector();
  const detachErrors = browserErrors.trackPage(page);
  const network = createNetworkCollector({ apiOrigin: API_ORIGIN });
  const detachNetwork = network.trackPage(page);
  const failedRequests: string[] = [];
  const onResponse = (response: Response) => {
    const url = new URL(response.url());
    if (url.origin === API_ORIGIN && response.status() >= 400) {
      failedRequests.push(
        `${response.request().method()} ${url.pathname} -> ${String(response.status())}`,
      );
    }
  };
  page.on("response", onResponse);

  return {
    finish: async () => {
      const navigationProblems: string[] = [];
      const landed = new URL(page.url());
      if (landed.pathname.startsWith("/auth")) {
        navigationProblems.push(
          `redirected to sign-in (${landed.pathname}): the seeded session is not valid; re-run agent:up`,
        );
      }
      if (
        (await page
          .getByRole("heading", { name: ROUTE_ERROR_HEADING })
          .count()) > 0
      ) {
        navigationProblems.push(
          `route error boundary rendered at ${landed.pathname}`,
        );
      }
      page.off("response", onResponse);
      detachNetwork();
      detachErrors();
      return {
        // Aborted outside requests are this driver's own doing.
        browserErrors: browserErrors
          .entries()
          .filter((entry) => !BLOCKED_REQUEST_ERROR.test(entry)),
        failedRequests,
        navigationProblems,
      };
    },
    network,
    page,
  };
};

// A missing ready element is a finding, not a crash: the screenshot of
// whatever rendered instead is the evidence.
const waitUntilReady = async (
  { network, page }: TrackedPage,
  selector = "main",
) => {
  const visible = await page
    .locator(selector)
    .first()
    .waitFor({ state: "visible", timeout: READY_TIMEOUT_MS })
    .then(
      () => true,
      () => false,
    );
  const loaded = await page
    .locator(LOADING_PLACEHOLDER)
    .first()
    .waitFor({ state: "hidden", timeout: READY_TIMEOUT_MS })
    .then(
      () => true,
      () => false,
    );
  const quiet = await network.waitForQuiet(QUIET);
  const problems: string[] = [];
  if (!visible) {
    problems.push(
      `${selector} was not visible after ${String(READY_TIMEOUT_MS)} ms`,
    );
  }
  if (!loaded) {
    problems.push(
      `loading placeholders still showed after ${String(READY_TIMEOUT_MS)} ms`,
    );
  }
  if (quiet === "timeout") {
    problems.push(
      `API requests were still running after ${String(QUIET.timeoutMs)} ms`,
    );
  }
  return { problems };
};

const slugify = (value: string) =>
  value
    .replace(/^\/+/u, "")
    .replace(/[^\w.-]+/gu, "-")
    .replace(/-+$/u, "") || "root";

const createOutputDir = async (name: string) => {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const outputDir = path.join(EVIDENCE_DIR, `${stamp}-${slugify(name)}`);
  await mkdir(outputDir, { recursive: true });
  return outputDir;
};

type ReportSection = { findings: PageFindings; lines: string[]; title: string };

const writeReport = async (outputDir: string, sections: ReportSection[]) => {
  const blocked =
    blockedRequests.size === 0
      ? ""
      : `\n\nBlocked requests to non-local origins: ${[...blockedRequests].toSorted().join(", ")}`;
  const markdown = sections
    .map(({ findings, lines, title }) =>
      [`## ${title}`, "", ...lines, "", formatFindings(findings)].join("\n"),
    )
    .join("\n\n")
    .concat(blocked);
  await writeFile(path.join(outputDir, "report.md"), `${markdown}\n`);
  console.log(markdown);
  console.log(`\nEvidence: ${outputDir}`);
  return sections.some(({ findings }) => hasBlockingFindings(findings));
};

const snap = async (targets: string[], options: DriveOptions) => {
  const session = await openSession(options);
  const outputDir = await createOutputDir(
    targets.length === 1 ? `snap-${targets.join("")}` : "snap",
  );
  const sections: ReportSection[] = [];
  try {
    for (const target of targets) {
      const context = await session.newContext();
      const tracked = await trackPage(context);
      await tracked.page.goto(target, { waitUntil: "domcontentloaded" });
      const ready = await waitUntilReady(tracked, options.waitFor);
      const screenshot = path.join(outputDir, `${slugify(target)}.png`);
      await capture({
        fullPage: options.fullPage,
        label: target,
        page: tracked.page,
        screenshotPath: screenshot,
      });
      const findings = await tracked.finish();
      findings.navigationProblems.push(...ready.problems);
      sections.push({
        findings,
        lines: [`- URL: ${tracked.page.url()}`, `- Screenshot: ${screenshot}`],
        title: target,
      });
      await context.close();
    }
  } finally {
    await session.browser.close();
  }
  return await writeReport(outputDir, sections);
};

type DriveScriptContext = {
  apiUrl: string;
  page: Page;
  // Screenshots after the same readiness checks as `snap`; `waitFor` names
  // the element that proves this step rendered (default `main`).
  snap: (label: string, options?: { waitFor?: string }) => Promise<void>;
  webUrl: string;
};

const isDriveScript = (
  value: unknown,
): value is (context: DriveScriptContext) => Promise<void> =>
  typeof value === "function";

const run = async (scriptPath: string, options: DriveOptions) => {
  const absolute = path.resolve(process.cwd(), scriptPath);
  const imported: unknown = await import(pathToFileURL(absolute).href);
  const script: unknown =
    typeof imported === "object" && imported !== null
      ? Reflect.get(imported, "default")
      : undefined;
  if (!isDriveScript(script)) {
    throw new Error(`${scriptPath} must default-export an async function`);
  }

  const session = await openSession(options);
  const outputDir = await createOutputDir(`run-${path.basename(scriptPath)}`);
  const lines: string[] = [];
  const stepProblems: string[] = [];
  let findings: PageFindings;
  try {
    const context = await session.newContext();
    const tracked = await trackPage(context);
    const scriptResult = await script({
      apiUrl: API_URL,
      page: tracked.page,
      snap: async (label, snapOptions) => {
        const ready = await waitUntilReady(
          tracked,
          snapOptions?.waitFor ?? options.waitFor,
        );
        stepProblems.push(
          ...ready.problems.map((problem) => `${label}: ${problem}`),
        );
        const screenshot = path.join(outputDir, `${slugify(label)}.png`);
        await capture({
          fullPage: options.fullPage,
          label,
          page: tracked.page,
          screenshotPath: screenshot,
        });
        lines.push(`- ${label}: ${screenshot}`);
      },
      webUrl: WEB_URL,
    }).then(
      () => null,
      (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    );
    findings = await tracked.finish();
    findings.navigationProblems.push(...stepProblems);
    if (scriptResult !== null) {
      // The failure screenshot is the most useful evidence of a broken step.
      const screenshot = path.join(outputDir, "failure.png");
      await capture({
        fullPage: false,
        label: "failure",
        page: tracked.page,
        screenshotPath: screenshot,
      });
      findings.navigationProblems.push(
        `script failed: ${scriptResult.message} (${screenshot})`,
      );
    }
    await context.close();
  } finally {
    await session.browser.close();
  }
  return await writeReport(outputDir, [{ findings, lines, title: scriptPath }]);
};

const readLcp = async (page: Page) =>
  await page.evaluate((name) => {
    const value: unknown = Reflect.get(window, name);
    return typeof value === "number" ? Math.round(value) : null;
  }, LCP_GLOBAL);

const readDomContentLoaded = async (page: Page) =>
  await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation").at(0);
    return entry instanceof PerformanceNavigationTiming
      ? Math.round(entry.domContentLoadedEventEnd)
      : null;
  });

const measureOnce = async (
  session: Session,
  target: string,
  options: DriveOptions,
) => {
  const context = await session.newContext();
  await context.addInitScript((name) => {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        Reflect.set(window, name, entry.startTime);
      }
    }).observe({ buffered: true, type: "largest-contentful-paint" });
  }, LCP_GLOBAL);
  const tracked = await trackPage(context);
  const startedAt = performance.now();
  await tracked.page.goto(target, { waitUntil: "domcontentloaded" });
  const ready = await waitUntilReady(tracked, options.waitFor);
  const settledMs = performance.now() - startedAt - QUIET.idleMs;
  const networkCapture = await tracked.network.capture();
  const sample: MeasureSample = {
    ...pageTotals(networkCapture),
    domContentLoadedMs: await readDomContentLoaded(tracked.page),
    largestContentfulPaintMs: await readLcp(tracked.page),
    settledMs,
    waterfallDepth: summarizeCapture(networkCapture).depth,
  };
  const findings = await tracked.finish();
  findings.navigationProblems.push(...ready.problems);
  await context.close();
  return { findings, sample };
};

const measure = async (target: string, options: DriveOptions) => {
  const session = await openSession(options);
  const samples: MeasureSample[] = [];
  const findings: PageFindings = {
    browserErrors: [],
    failedRequests: [],
    navigationProblems: [],
  };
  const addFindings = (next: PageFindings) => {
    findings.browserErrors.push(...next.browserErrors);
    findings.failedRequests.push(...next.failedRequests);
    findings.navigationProblems.push(...next.navigationProblems);
  };
  try {
    // The warm-up pays the dev server's on-demand compile, so its timings are
    // dropped; its findings are not, since a first-visit failure is real.
    addFindings((await measureOnce(session, target, options)).findings);
    for (let index = 0; index < options.samples; index++) {
      const result = await measureOnce(session, target, options);
      samples.push(result.sample);
      addFindings(result.findings);
    }
  } finally {
    await session.browser.close();
  }

  const summary = summarizeSamples(target, samples);
  const outputDir = await createOutputDir(`measure-${target}`);
  await writeFile(
    path.join(outputDir, "samples.json"),
    `${JSON.stringify({ samples, summary }, null, 2)}\n`,
  );

  await mkdir(MEASUREMENTS_DIR, { recursive: true });
  if (options.save !== undefined) {
    await writeFile(
      path.join(MEASUREMENTS_DIR, `${options.save}.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }
  const previous =
    options.compare === undefined
      ? undefined
      : await readSavedSummary(options.compare);
  if (previous !== undefined && previous.summary.path !== target) {
    throw new Error(
      `--compare ${previous.label} was measured on ${previous.summary.path}, not ${target}`,
    );
  }

  const lines = [
    `Median of ${String(samples.length)} samples after one warm-up, dev build: compare runs against each other, not against production. A timing delta outside the spread is still one before/after pair; repeat it before claiming it.`,
    "",
    formatSummaryTable(summary, previous),
  ];
  if (options.save !== undefined) {
    lines.push(
      "",
      `Saved as ${options.save}; compare later with --compare ${options.save}.`,
    );
  }
  return await writeReport(outputDir, [
    { findings, lines, title: `measure ${target}` },
  ]);
};

const readSavedSummary = async (label: string) => {
  const filePath = path.join(MEASUREMENTS_DIR, `${label}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`No saved measurement named ${label} (${filePath})`);
  }
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf-8"));
  if (!isMeasureSummary(parsed)) {
    throw new Error(`${filePath} is not a measurement summary`);
  }
  return { label, summary: parsed };
};

const main = async () => {
  const parsed = parseDriveArgs(process.argv.slice(2));
  if (parsed.type === "error") {
    console.error(parsed.message);
    process.exit(2);
  }
  const { command, options, targets } = parsed.args;
  const [target = ""] = targets;
  let blocking: boolean;
  switch (command) {
    case "snap": {
      blocking = await snap(targets, options);
      break;
    }
    case "run": {
      blocking = await run(target, options);
      break;
    }
    case "measure": {
      blocking = await measure(target, options);
      break;
    }
    default: {
      command satisfies never;
      panic(`Unhandled drive command: ${String(command)}`);
    }
  }
  process.exit(blocking ? 1 : 0);
};

await main();
