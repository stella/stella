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

/**
 * A settled download until a result hands it out; see `shownDocument` on
 * the bridge's report. One saved while a run was held belongs to that
 * run: its path is relative to that run's folder, so only that run's
 * results hand it out. One that arrived between runs waits for the next
 * run to take it, which saves it into its own folder.
 */
type HeldDownload = { shownDocument: string | null } & (
  | {
      type: "saving";
      outcome: Promise<BrowserDownloadOutcome>;
      runId: string;
    }
  | { type: "waiting"; download: BrowserDownload }
);

/** Whether `run`'s result may hand out `entry`. */
const heldFor = (entry: HeldDownload, runId: string): boolean =>
  entry.type === "waiting" || entry.runId === runId;

type Started = {
  /** When it was announced, in the inbox's clock. */
  at: number;
  /** The run held when it was announced, whose folder it will land in; null between runs. */
  runId: string | null;
  /** The address of the shown PDF it saves; null for a page's download. */
  shownDocument: string | null;
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
  /** Whether the shown document's own save is among those still saving. */
  shownSaving: boolean;
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
  /** Judges and moves one settled download; `downloads.ts` unless a test stands in. */
  receive?: typeof receiveBrowserDownload;
};

const emptyChat = (): ChatDownloads => ({ held: [], started: new Map() });

/** The newest `limit` entries of a map, in insertion order. */
const newest = <K, V>(map: Map<K, V>, limit: number): Map<K, V> =>
  new Map([...map].slice(-limit));

export const createDownloadInbox = ({
  clock = systemInboxClock,
  home,
  receive: receiveDownload = receiveBrowserDownload,
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
    await receiveDownload(download, {
      home,
      workspaceDir: run.workspaceDir,
    });

  /** The downloads still saving that `runId`'s results may count. */
  const savingFor = (chat: ChatDownloads, runId: string): Started[] =>
    [...chat.started.values()].filter(
      (started) => started.runId === null || started.runId === runId,
    );

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

  /**
   * Records what each shown document's save became, by the document's
   * address. A saved copy stands: a later refusal for the same document
   * (one more read stopped for the limit, say) never replaces it.
   */
  const remember = (
    runId: string,
    settled: readonly {
      outcome: BrowserDownloadOutcome;
      shownDocument: string | null;
    }[],
  ) => {
    const record =
      known.get(runId) ?? new Map<string, BrowserDownloadOutcome>();
    for (const { outcome, shownDocument } of settled) {
      if (shownDocument === null) {
        continue;
      }
      const address = browserDocumentAddress(shownDocument);
      if (
        outcome.status === "refused" &&
        record.get(address)?.status === "saved"
      ) {
        continue;
      }
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
            runId: runOf(report.controllerId)?.runId ?? null,
            sequence: announced,
            shownDocument:
              report.shownDocument === null
                ? null
                : browserDocumentAddress(report.shownDocument),
          });
          chat.started = newest(chat.started, MAX_STARTED_DOWNLOADS);
          return;
        case "settled": {
          chat.started.delete(report.deliveryId);
          const run = runOf(report.controllerId);
          const { shownDocument } = report;
          const held: HeldDownload =
            run === null
              ? { download: report.download, shownDocument, type: "waiting" }
              : {
                  outcome: receive(report.download, run),
                  runId: run.runId,
                  shownDocument,
                  type: "saving",
                };
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
      const held = chat.held.filter((entry) => heldFor(entry, run.runId));
      chat.held = chat.held.filter((entry) => !heldFor(entry, run.runId));
      const expired = clock.now() - STARTED_DOWNLOAD_TTL_MS;
      chat.started = new Map(
        [...chat.started].filter(([, { at }]) => at >= expired),
      );
      // Read now, with the held list: a download that settles while this
      // result waits for the ones it holds is counted as still saving here
      // and listed by the next result, never lost between the two.
      const shownDocument =
        shownAddress === null ? null : browserDocumentAddress(shownAddress);
      const saving = savingFor(chat, run.runId);
      const shownSaving =
        shownDocument !== null &&
        saving.some((started) => started.shownDocument === shownDocument);
      const settled = await Promise.all(
        held.map(async (entry) => {
          switch (entry.type) {
            case "saving":
              return {
                outcome: await entry.outcome,
                shownDocument: entry.shownDocument,
              };
            case "waiting":
              return {
                outcome: await receive(entry.download, run),
                shownDocument: entry.shownDocument,
              };
            default:
              entry satisfies never;
              return panic("Unhandled held download");
          }
        }),
      );
      remember(run.runId, settled);
      return {
        downloads: settled.map(({ outcome }) => outcome),
        saving: saving.length,
        shownSaving,
        shown:
          shownDocument === null
            ? null
            : (known.get(run.runId)?.get(shownDocument) ?? null),
      };
    },
    /**
     * The run ended: what its documents became is forgotten, and what it
     * saved but no result of it handed out goes with it, since its paths
     * are relative to that run's folder.
     */
    forgetRun: (runId: string) => {
      known.delete(runId);
      for (const chat of chats.values()) {
        chat.held = chat.held.filter(
          (entry) => entry.type === "waiting" || entry.runId !== runId,
        );
        chat.started = new Map(
          [...chat.started].filter(([, started]) => started.runId !== runId),
        );
      }
    },
    clear: () => {
      chats.clear();
      known.clear();
      listeners.clear();
    },
  };
};
