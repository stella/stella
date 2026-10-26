/// <reference lib="dom" />
import type { BrowserContext, Page, Request, Response } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sleep } from "@stll/concurrency/sleep";
import type { RenderSnapshot } from "@stll/render-probe";

import { readBrowserProbe } from "./render-probe-contract";

export type RenderActionMeasurement = RenderSnapshot & {
  label: string;
  wallMs: number;
  longTasks: number;
  longTaskMs: number;
  textDeltas?: number;
  rendersPerDelta?: number;
};

const QUIET_MS = 500;
const TIMEOUT_MS = 30_000;
let bundle: Promise<string> | undefined;

type PageNetworkState = {
  pending: Set<Request>;
  lastActivityAt: number;
};

const networks = new WeakMap<Page, PageNetworkState>();
const trackedContexts = new WeakSet<BrowserContext>();
const requestNetworks = new WeakMap<Request, PageNetworkState>();

const pageNetwork = (page: Page) => {
  const existing = networks.get(page);
  if (existing !== undefined) {
    return existing;
  }
  const state = { pending: new Set<Request>(), lastActivityAt: Date.now() };
  networks.set(page, state);
  page.once("close", () => state.pending.clear());
  return state;
};

const trackContextNetwork = (context: BrowserContext) => {
  if (trackedContexts.has(context)) {
    return;
  }
  trackedContexts.add(context);
  for (const page of context.pages()) {
    pageNetwork(page);
  }
  context.on("page", pageNetwork);
  context.on("request", (request) => {
    if (
      request.serviceWorker() !== null ||
      (request.resourceType() !== "fetch" && request.resourceType() !== "xhr")
    ) {
      return;
    }
    const state = pageNetwork(request.frame().page());
    requestNetworks.set(request, state);
    state.pending.add(request);
    state.lastActivityAt = Date.now();
  });
  const onSettled = (request: Request) => {
    const state = requestNetworks.get(request);
    if (state === undefined) {
      return;
    }
    if (state.pending.delete(request)) {
      state.lastActivityAt = Date.now();
    }
  };
  context.on("requestfinished", onSettled);
  context.on("requestfailed", onSettled);
  context.on("response", (response: Response) => {
    if (response.headers()["content-type"]?.includes("text/event-stream")) {
      onSettled(response.request());
    }
  });
};

const buildProbe = async () => {
  // Playwright's test workers use Node; the agent driver uses Bun. Keep the
  // bundler in Bun in both cases, with one cached build per caller process.
  const result = await promisify(execFile)(
    "bun",
    [new URL("render-probe-bundle.ts", import.meta.url).pathname],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return result.stdout;
};

/** Install before creating the first page, so React and Refresh see the hook. */
export const installRenderProbe = async (context: BrowserContext) => {
  trackContextNetwork(context);
  bundle ??= buildProbe();
  await context.addInitScript({ content: await bundle });
};

/** The action must use real input and await any stream whose work it includes. */
export const measureAction = async (
  page: Page,
  label: string,
  action: () => Promise<unknown>,
): Promise<RenderActionMeasurement> => {
  if (!trackedContexts.has(page.context())) {
    throw new Error(
      "Install the render probe before creating the measured page",
    );
  }
  const network = pageNetwork(page);
  const waitUntilQuiet = async (actionEndedAt = 0) => {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await page.evaluate(readBrowserProbe, "read");
      const reactQuiet =
        state.rendererCount > 0 &&
        state.observedCommits > 0 &&
        Date.now() - Math.max(actionEndedAt, state.lastCommitAt) >= QUIET_MS;
      if (
        reactQuiet &&
        network.pending.size === 0 &&
        Date.now() - network.lastActivityAt >= QUIET_MS
      ) {
        return;
      }
      await sleep(50);
    }
    throw new Error(
      `React or API activity did not become quiet during ${label}`,
    );
  };
  await waitUntilQuiet();
  const reset = await page.evaluate(readBrowserProbe, "reset");
  if (reset.startedAt === null) {
    throw new Error("The render probe did not reset its measurement");
  }
  const startedAt = reset.startedAt;
  const actionResult = await action();
  await waitUntilQuiet(Date.now());
  const result = await page.evaluate(readBrowserProbe, "read");
  if (result.rendererCount === 0 || result.observedCommits === 0) {
    throw new Error(`The render probe lost its React renderer during ${label}`);
  }
  const textDeltas: unknown =
    typeof actionResult === "object" &&
    actionResult !== null &&
    "textDeltas" in actionResult
      ? actionResult.textDeltas
      : undefined;
  if (
    textDeltas !== undefined &&
    (typeof textDeltas !== "number" ||
      !Number.isInteger(textDeltas) ||
      textDeltas <= 0)
  ) {
    throw new Error(
      `The streamed action ${label} did not count positive text deltas`,
    );
  }
  return {
    ...result.snapshot,
    label,
    wallMs:
      result.snapshot.commits === 0
        ? 0
        : Math.max(0, result.lastCommitAt - startedAt),
    longTasks: result.longTasks,
    longTaskMs: result.longTaskMs,
    ...(typeof textDeltas === "number"
      ? { textDeltas, rendersPerDelta: result.snapshot.renders / textDeltas }
      : {}),
  };
};
