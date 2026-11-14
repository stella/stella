import { panic } from "better-result";
import { Temporal } from "temporal-polyfill/full";

import {
  browserDocumentAddress,
  type BrowserDownload,
} from "@stll/api-contract/browser-control";

import type { BrowserBridgeDownload } from "./bridge";
import {
  type BrowserDownloadOutcome,
  receiveBrowserDownload,
} from "./downloads";

/**
 * Each chat's downloads, from the extension's reports until a browser result
 * of the chat hands them to the agent. A settled download is saved into the
 * folder of the chat's run held at the time, at once, or of the next run to
 * take it. A browser step waits a moment for the downloads it started, so
 * a PDF its click or open saved is in that step's own result; one still
 * saving after the wait is counted and listed by a later result.
 */

/**
 * How long a browser result waits for downloads its step started: long
 * enough for a typical PDF to finish and be checked, short enough that a
 * slow one never holds the step.
 */
export const DOWNLOAD_SETTLE_WAIT_MS = 3000;

/**
 * A started download whose report never came (the extension restarted
 * while it ran) stops counting as saving after this long.
 */
const STARTED_DOWNLOAD_TTL_MS = 10 * 60_000;

/** Downloads one chat keeps for its next browser result; older ones go first. */
const MAX_HELD_DOWNLOADS = 16;

/** Started downloads one chat keeps track of; older ones go first. */
const MAX_STARTED_DOWNLOADS = 16;

/** Outcomes each run remembers by address; older ones go first. */
const MAX_KNOWN_ADDRESSES = 64;

/** The run a result is taken for: whose folder downloads land in. */
type InboxRun = { runId: string; threadId: string; workspaceDir: string };

type HeldDownload =
  | { type: "saving"; outcome: Promise<BrowserDownloadOutcome> }
  | { type: "waiting"; download: BrowserDownload };

type Started = {
  /** When it was announced, in the inbox's clock. */
  at: number;
  /** Its place in the order downloads were announced. */
  sequence: number;
};

type ChatDownloads = {
  held: HeldDownload[];
  /** Announced and not yet settled, by delivery id. */
  started: Map<string, Started>;
};

/** What a browser result carries of the chat's downloads. */
export type TakenDownloads = {
  /** Every download settled since the chat's last result. */
  downloads: BrowserDownloadOutcome[];
  /** Downloads Chrome is still saving; a later result lists them. */
  saving: number;
  /**
   * For a result showing a document: what became of that document's own
   * save in this run, the latest when there were several; null when none
   * is known yet.
   */
  shown: BrowserDownloadOutcome | null;
};

type TakeOptions = {
  /** The announcement count when the step began: later ones are its own. */
  since: number;
  /** The address of the document the result shows, when it is one to save. */
  shownAddress: string | null;
  /** Ends the wait early. */
  signal: AbortSignal;
};

/** Where the inbox reads the time and sets its one timer. */
type InboxClock = {
  now: () => number;
  /** Runs `task` after `ms`; the returned function cancels it. */
  schedule: (task: () => void, ms: number) => () => void;
};

const systemInboxClock: InboxClock = {
  now: () => Temporal.Now.instant().epochMilliseconds,
  schedule: (task, ms) => {
    const timer = setTimeout(task, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

type InboxOptions = {
  /** The run of a chat held now, if any. */
  runOf: (threadId: string) => InboxRun | null;
  /** The member's home folder: Chrome saves downloads under it. */
  home: string;
  clock?: InboxClock;
};

const emptyChat = (): ChatDownloads => ({ held: [], started: new Map() });

/** The newest `limit` entries of a map, in insertion order. */
const newest = <K, V>(map: Map<K, V>, limit: number): Map<K, V> =>
  new Map([...map].slice(-limit));

export const createDownloadInbox = ({
  clock = systemInboxClock,
  home,
  runOf,
}: InboxOptions) => {
  const chats = new Map<string, ChatDownloads>();
  /** What each run's documents became, by address: repeated on a later read. */
  const known = new Map<string, Map<string, BrowserDownloadOutcome>>();
  /** Called whenever a chat's report arrives. */
  const listeners = new Set<() => void>();
  let announced = 0;

  const chatOf = (threadId: string): ChatDownloads => {
    const existing = chats.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created = emptyChat();
    chats.set(threadId, created);
    return created;
  };

  const receive = async (download: BrowserDownload, run: InboxRun) =>
    await receiveBrowserDownload(download, {
      home,
      workspaceDir: run.workspaceDir,
    });

  /** Whether a download announced after `since` is still saving. */
  const stillSaving = (chat: ChatDownloads, since: number): boolean =>
    [...chat.started.values()].some(({ sequence }) => sequence > since);

  /** Waits until the step's own downloads settled, the wait ran out or `signal` ended. */
  const settle = async (
    threadId: string,
    since: number,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!stillSaving(chatOf(threadId), since) || signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        cancel();
        listeners.delete(check);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const check = () => {
        if (!stillSaving(chatOf(threadId), since)) {
          done();
        }
      };
      const cancel = clock.schedule(done, DOWNLOAD_SETTLE_WAIT_MS);
      listeners.add(check);
      signal.addEventListener("abort", done, { once: true });
    });
  };

  const remember = (runId: string, outcomes: BrowserDownloadOutcome[]) => {
    const record =
      known.get(runId) ?? new Map<string, BrowserDownloadOutcome>();
    for (const outcome of outcomes) {
      const address = browserDocumentAddress(outcome.sourceUrl);
      record.delete(address);
      record.set(address, outcome);
    }
    known.set(runId, newest(record, MAX_KNOWN_ADDRESSES));
  };

  return {
    arrive: (report: BrowserBridgeDownload) => {
      const chat = chatOf(report.controllerId);
      switch (report.type) {
        case "started":
          announced += 1;
          chat.started.set(report.deliveryId, {
            at: clock.now(),
            sequence: announced,
          });
          chat.started = newest(chat.started, MAX_STARTED_DOWNLOADS);
          return;
        case "settled": {
          chat.started.delete(report.deliveryId);
          const run = runOf(report.controllerId);
          const held: HeldDownload =
            run === null
              ? { download: report.download, type: "waiting" }
              : { outcome: receive(report.download, run), type: "saving" };
          chat.held = [...chat.held, held].slice(-MAX_HELD_DOWNLOADS);
          for (const listener of [...listeners]) {
            listener();
          }
          return;
        }
        default:
          report satisfies never;
          panic("Unhandled download report");
      }
    },
    /** The announcement count now: a step passes it back as `since`. */
    mark: (): number => announced,
    /**
     * The chat's downloads so far, saved into `run`'s folder; each is
     * handed out once. Waits a moment for the downloads the step started.
     */
    take: async (
      run: InboxRun,
      { shownAddress, signal, since }: TakeOptions,
    ): Promise<TakenDownloads> => {
      await settle(run.threadId, since, signal);
      const chat = chatOf(run.threadId);
      const held = chat.held;
      chat.held = [];
      const expired = clock.now() - STARTED_DOWNLOAD_TTL_MS;
      chat.started = new Map(
        [...chat.started].filter(([, { at }]) => at >= expired),
      );
      const downloads = await Promise.all(
        held.map(async (entry) => {
          switch (entry.type) {
            case "saving":
              return await entry.outcome;
            case "waiting":
              return await receive(entry.download, run);
            default:
              entry satisfies never;
              return panic("Unhandled held download");
          }
        }),
      );
      remember(run.runId, downloads);
      return {
        downloads,
        saving: chat.started.size,
        shown:
          shownAddress === null
            ? null
            : (known
                .get(run.runId)
                ?.get(browserDocumentAddress(shownAddress)) ?? null),
      };
    },
    /** The run ended: what its documents became is forgotten. */
    forgetRun: (runId: string) => {
      known.delete(runId);
    },
    clear: () => {
      chats.clear();
      known.clear();
      listeners.clear();
    },
  };
};
