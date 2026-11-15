import { panic, Result } from "better-result";
import { appendFileSync } from "node:fs";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  type BrowserControlCommand,
  type BrowserControlResult,
  PRODUCTION_STELLA_ORIGINS,
} from "@stll/api-contract/browser-control";
import { browserControlError } from "@stll/browser-page/browser-control-result";
import {
  createOriginPolicy,
  type OriginPolicy,
} from "@stll/browser-page/origin-policy";
import { createDetached } from "@stll/errors";
import { sha256Hex } from "@stll/sha256/node";

import type { BrowserHost, BrowserHostRequest } from "../browser-host";
import { localBrowserResult } from "../local-result";
import type { CdpMethod } from "./cdp-client";
import { findInstalledBrowser, realBrowserFileSystem } from "./find-browser";
import {
  type BrowserInstance,
  startBrowserInstance,
  type StartFailure,
} from "./instance";
import {
  browserEnvironment,
  type BrowserProcesses,
  prepareProfile,
  realBrowserProcesses,
} from "./launch";
import {
  findOnPage,
  openPage,
  type ReadContext,
  readSnapshot,
} from "./read-path";
import { createTargets, type Targets } from "./targets";

/**
 * The stella browser as a browser host: Chrome or Edge on this computer,
 * started by the holder on a profile of its own, driven over the debugging
 * pipe. It starts on the first `open` a chat sends here and closes when the
 * holder exits or no chat has a tab in it any more; one that crashed or
 * was quit starts again on the next `open`.
 *
 * This slice reads: open, snapshot by cursor, find and headings, and the
 * sign-in handoff. Steps that change a page are refused as not available
 * on this browser yet. Until its network rules match the extension's,
 * every `open` goes through the origin policy and every read re-checks the
 * address of the document it read.
 */

export const NOT_AVAILABLE_ON_STELLA_BROWSER =
  "This step is not available in the stella browser yet: it can open pages and read them (snapshot, find, headings), but not click, type, press keys, choose options, go back or switch tabs.";

const NO_ACCOUNT =
  "stella desktop has not connected to this computer's agent yet, so the stella browser cannot start. Try again in a moment.";

const START_FAILURES = {
  "in-use":
    "The stella browser's profile is in use by another program, so it was not started. Ask the member to close it, then try again.",
  "did-not-start": "The stella browser did not start. Try again.",
  "no-answer": "The stella browser started but did not answer. Try again.",
  "too-old":
    "The browser on this computer is too old for the stella browser. Ask the member to update Chrome or Edge, then try again.",
} as const satisfies Record<StartFailure["type"], string>;

const GONE =
  "The stella browser closed, and the chat's tabs with it. Call open to continue.";

const disconnected = (message: string): BrowserControlResult =>
  browserControlError(BROWSER_CONTROL_ERROR_CODE.disconnected, message);

/** The member's profile key: the account's origin, until the account's user id reaches the holder. */
const memberKeyOf = (apiOrigin: string) => sha256Hex(apiOrigin).slice(0, 16);

/** The origin policy with the account's stella origins refused as well. */
const accountPolicy = (apiOrigin: string): OriginPolicy => {
  const origins = new Set<string>([...PRODUCTION_STELLA_ORIGINS, apiOrigin]);
  return createOriginPolicy({
    hostnames: [...origins].flatMap((origin) => {
      const url = URL.parse(origin);
      return url === null ? [] : [url.hostname];
    }),
    originFromUrl: (rawUrl) => {
      const origin = URL.parse(rawUrl)?.origin;
      return origin !== undefined && origins.has(origin) ? origin : null;
    },
  });
};

export type StellaBrowserHostOptions = {
  /** Where profiles live: `<app data>/browser`. */
  profileRoot: string;
  /** The connected desktop's API origin, or null before the first hello. */
  accountOrigin: () => string | null;
  home: string | null;
  platform: NodeJS.Platform;
  /** The environment the holder started with; the browser gets a minimal part of it. */
  environment: Readonly<Record<string, string | undefined>>;
  /** Set only by tests, and only where the build keeps the test hooks. */
  testHooks: {
    executable: string;
    args: readonly string[];
    methodLog: string | null;
    browserLog: string | null;
  } | null;
  log: (line: string) => void;
  processes?: BrowserProcesses;
};

type Running = {
  instance: BrowserInstance;
  targets: Targets;
  /** The account the browser's profile is: never used for another. */
  memberKey: string;
  /** Isolated worlds by document, shared by every chat's reads. */
  worlds: Map<string, number>;
};

export type StellaBrowserHost = BrowserHost & {
  /** Closes the browser, one starting too, and starts none again: the holder is exiting. */
  stop: () => Promise<void>;
};

const noTab = (): BrowserControlResult =>
  browserControlError(
    BROWSER_CONTROL_ERROR_CODE.noControlledTab,
    "No tab is open for this chat in the stella browser. Open a page first.",
  );

const cancelled = (): BrowserControlResult =>
  browserControlError(
    BROWSER_CONTROL_ERROR_CODE.cancelled,
    "The browser step was stopped before it ran.",
  );

const STOPPED =
  "The stella browser is closing with stella's agent on this computer.";

/** What a read in the chat's active tab works with; null when the chat has none. */
const readingIn = (
  current: Running,
  controllerId: string,
  signal: AbortSignal,
  policy: OriginPolicy,
): ReadContext | null => {
  const tab = current.targets.activeTab(controllerId);
  return tab === null
    ? null
    : {
        chatTabs: () => current.targets.chatTabs(controllerId),
        client: current.instance.client,
        policy,
        signal,
        tab,
        worlds: current.worlds,
      };
};

type Step = {
  controllerId: string;
  signal: AbortSignal;
  policy: OriginPolicy;
};

/**
 * Opens `requested` in the chat's tab, or in a new window of the chat's.
 * A chat keeps at most the contract's number of tabs: one more is refused
 * before the browser makes a window.
 */
const openIn = async (
  current: Running,
  { controllerId, policy, signal }: Step,
  { newTab, requested }: { newTab: boolean; requested: URL },
): Promise<BrowserControlResult> => {
  if (newTab || current.targets.activeTab(controllerId) === null) {
    if (
      current.targets.chatTabs(controllerId).length >=
      BROWSER_CONTROL_LIMITS.tabs
    ) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.tabLimitReached,
        `Chat already has ${String(BROWSER_CONTROL_LIMITS.tabs)} tabs open, the most it may keep. Open the page in the current tab without newTab.`,
      );
    }
    const opened = await current.targets.openTab(controllerId, signal);
    if (Result.isError(opened)) {
      return opened.error.type === "aborted"
        ? cancelled()
        : browserControlError(
            BROWSER_CONTROL_ERROR_CODE.navigationFailed,
            "The stella browser could not open a window for this page.",
          );
    }
  }
  const reading = readingIn(current, controllerId, signal, policy);
  return reading === null ? noTab() : await openPage(reading, requested);
};

/** Reads the chat's active tab: a window of it, or what find asked for. */
const readIn = async (
  current: Running | null,
  { controllerId, policy, signal }: Step,
  command: Extract<BrowserControlCommand, { action: "find" | "snapshot" }>,
): Promise<BrowserControlResult> => {
  if (current === null) {
    return noTab();
  }
  if (current.instance.isGone()) {
    return disconnected(GONE);
  }
  const reading = readingIn(current, controllerId, signal, policy);
  if (reading === null) {
    return noTab();
  }
  return command.action === BROWSER_CONTROL_ACTION.find
    ? await findOnPage(reading, command)
    : await readSnapshot(reading, command.cursor);
};

/** Appends each method to the test hooks' log the first time it is sent. */
const methodRecorder = (methodLog: string | null) => {
  const sent = new Set<CdpMethod>();
  return (method: CdpMethod) => {
    if (methodLog !== null && !sent.has(method)) {
      sent.add(method);
      appendFileSync(methodLog, `${method}\n`);
    }
  };
};

/**
 * Runs each chat's commands one at a time, in order, whatever the one
 * before did. A chat's cancel stops its command running and every one
 * still queued behind it.
 */
export const chatQueues = () => {
  const queues = new Map<string, Promise<unknown>>();
  const stops = new Map<string, Set<AbortController>>();
  return {
    run: async <T>(
      controllerId: string,
      signal: AbortSignal,
      work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const stop = new AbortController();
      const chat = stops.get(controllerId) ?? new Set<AbortController>();
      chat.add(stop);
      stops.set(controllerId, chat);
      const previous = queues.get(controllerId) ?? Promise.resolve();
      const turn = Promise.allSettled([previous]).then(
        async () => await work(AbortSignal.any([signal, stop.signal])),
      );
      queues.set(controllerId, turn);
      return await turn.finally(() => {
        chat.delete(stop);
        if (chat.size === 0 && stops.get(controllerId) === chat) {
          stops.delete(controllerId);
        }
        if (queues.get(controllerId) === turn) {
          queues.delete(controllerId);
        }
      });
    },
    cancel: (controllerId: string) => {
      for (const stop of stops.get(controllerId) ?? []) {
        stop.abort();
      }
    },
  };
};

/**
 * Read through a call: TypeScript keeps a checked `signal.aborted` narrowed
 * across awaits, but a stop can land during any of them.
 */
const isStopped = (signal: AbortSignal): boolean => signal.aborted;

/** Starts the account's browser on its profile; why not, as the tools report it. */
const startFor = async (
  {
    environment,
    home,
    log,
    platform,
    processes = realBrowserProcesses,
    profileRoot,
    testHooks,
  }: StellaBrowserHostOptions,
  memberKey: string,
  recordMethod: (method: CdpMethod) => void,
): Promise<BrowserInstance | BrowserControlResult> => {
  const browser =
    testHooks?.executable ??
    findInstalledBrowser({ fs: realBrowserFileSystem, home, platform })
      ?.executable;
  if (browser === undefined) {
    return disconnected(
      "Neither Google Chrome nor Microsoft Edge is installed on this computer, so the stella browser cannot start.",
    );
  }
  const profile = prepareProfile(profileRoot, memberKey);
  if (Result.isError(profile)) {
    return disconnected(profile.error.message);
  }
  const started = await startBrowserInstance({
    environment: browserEnvironment(environment),
    errorLog: testHooks?.browserLog ?? null,
    executable: browser,
    onMethod: recordMethod,
    processes,
    profile: profile.value,
    testArgs: testHooks?.args ?? [],
  });
  if (Result.isError(started)) {
    log(`the stella browser did not start: ${started.error.type}`);
    return disconnected(START_FAILURES[started.error.type]);
  }
  return started.value;
};

export const createStellaBrowserHost = (
  options: StellaBrowserHostOptions,
): StellaBrowserHost => {
  const { accountOrigin, log, testHooks } = options;
  const detached = createDetached((_error, task) => {
    log(`stella browser background work failed: ${task}`);
  });
  let running: Running | null = null;
  let starting: {
    memberKey: string;
    started: Promise<Running | BrowserControlResult>;
  } | null = null;
  let stopped = false;
  const queues = chatQueues();
  /** How often each chat was released: a command from before a release leaves nothing open. */
  const releases = new Map<string, number>();
  const recordMethod = methodRecorder(testHooks?.methodLog ?? null);

  const closeRunning = async () => {
    const current = running;
    running = null;
    await current?.instance.close();
  };

  const launch = async (
    memberKey: string,
  ): Promise<Running | BrowserControlResult> => {
    const started = await startFor(options, memberKey, recordMethod);
    if ("status" in started) {
      return started;
    }
    // The holder began to stop while the browser started: it closes again.
    if (stopped) {
      await started.close();
      return disconnected(STOPPED);
    }
    log(
      `the stella browser started: ${started.product} (pid ${String(started.pid)})`,
    );
    const next: Running = {
      instance: started,
      memberKey,
      targets: createTargets(started.client, detached),
      worlds: new Map(),
    };
    running = next;
    detached(
      started.gone.then((end) => {
        log(`the stella browser closed: ${end.type}`);
        if (running === next) {
          running = null;
        }
        return undefined;
      }),
      "stella-browser.gone",
    );
    return next;
  };

  /**
   * The account's running browser, started when none runs. A browser of
   * another account (the desktop signed in as someone else) is never used:
   * it closes, with its tabs, before this account's starts.
   */
  const ensureRunning = async (
    apiOrigin: string,
  ): Promise<Running | BrowserControlResult> => {
    const memberKey = memberKeyOf(apiOrigin);
    if (starting !== null && starting.memberKey !== memberKey) {
      await starting.started;
    }
    if (stopped) {
      return disconnected(STOPPED);
    }
    if (starting !== null) {
      return await starting.started;
    }
    if (running?.memberKey === memberKey && !running.instance.isGone()) {
      return running;
    }
    await closeRunning();
    const launching = {
      memberKey,
      started: launch(memberKey).finally(() => {
        if (starting === launching) {
          starting = null;
        }
      }),
    };
    starting = launching;
    return await launching.started;
  };

  /** Closes the browser once no chat has a tab in it. */
  const closeIfIdle = async (current: Running) => {
    if (!current.targets.holdsTabs() && running === current) {
      await closeRunning();
    }
  };

  const open = async (
    step: Step,
    apiOrigin: string,
    command: Extract<BrowserControlCommand, { action: "open" }>,
    releasedBefore: number,
  ): Promise<BrowserControlResult> => {
    const requested = step.policy.parseControllableUrl(command.url);
    if (requested === null) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.navigationFailed,
        "Only public HTTPS pages without embedded credentials can be opened; stella itself and intranet, loopback and private addresses are refused.",
      );
    }
    // Stopped, or released, while it waited in the chat's queue.
    if (isStopped(step.signal)) {
      return cancelled();
    }
    const current = await ensureRunning(apiOrigin);
    if ("status" in current) {
      return current;
    }
    const result = isStopped(step.signal)
      ? cancelled()
      : await openIn(current, step, {
          newTab: command.newTab === true,
          requested,
        });
    // The chat was released while this open waited or ran: what it opened
    // goes with the chat.
    if ((releases.get(step.controllerId) ?? 0) !== releasedBefore) {
      await current.targets.releaseChat(step.controllerId);
      await closeIfIdle(current);
    }
    return result;
  };

  const run = async (
    { command, controllerId }: BrowserHostRequest,
    signal: AbortSignal,
    releasedBefore: number,
  ): Promise<BrowserControlResult> => {
    const apiOrigin = accountOrigin();
    if (apiOrigin === null) {
      return disconnected(NO_ACCOUNT);
    }
    const step: Step = {
      controllerId,
      policy: accountPolicy(apiOrigin),
      signal,
    };
    switch (command.action) {
      case BROWSER_CONTROL_ACTION.open:
        return await open(step, apiOrigin, command, releasedBefore);
      case BROWSER_CONTROL_ACTION.snapshot:
      case BROWSER_CONTROL_ACTION.find:
        return await readIn(
          running?.memberKey === memberKeyOf(apiOrigin) ? running : null,
          step,
          command,
        );
      case BROWSER_CONTROL_ACTION.click:
      case BROWSER_CONTROL_ACTION.fill:
      case BROWSER_CONTROL_ACTION.pressKey:
      case BROWSER_CONTROL_ACTION.select:
      case BROWSER_CONTROL_ACTION.goBack:
      case BROWSER_CONTROL_ACTION.switchTab:
        return browserControlError(
          BROWSER_CONTROL_ERROR_CODE.executionFailed,
          NOT_AVAILABLE_ON_STELLA_BROWSER,
        );
      default:
        command satisfies never;
        return panic("Unhandled browser command");
    }
  };

  return {
    acts: false,
    request: async (request, signal) => {
      const releasedBefore = releases.get(request.controllerId) ?? 0;
      return localBrowserResult(
        await queues.run(
          request.controllerId,
          signal,
          async (stoppable) => await run(request, stoppable, releasedBefore),
        ),
      );
    },
    cancel: ({ controllerId }) => {
      queues.cancel(controllerId);
    },
    releaseChat: (controllerId) => {
      releases.set(controllerId, (releases.get(controllerId) ?? 0) + 1);
      // Its queued and running commands stop; an open among them closes
      // what it made (see `open`).
      queues.cancel(controllerId);
      const current = running;
      if (current === null) {
        return;
      }
      detached(
        current.targets.releaseChat(controllerId).then(async () => {
          // No chat has a tab left: the browser closes until the next open.
          await closeIfIdle(current);
          return undefined;
        }),
        "stella-browser.release-chat",
      );
    },
    stop: async () => {
      stopped = true;
      // A browser still starting closes as soon as it has (see `launch`).
      await starting?.started;
      await closeRunning();
    },
  };
};
