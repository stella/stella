import { panic } from "better-result";
import { Temporal } from "temporal-polyfill/full";

import {
  browserDocumentAddress,
  type BrowserDownload,
} from "@stll/api-contract/browser-control";
import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";

import {
  type FileBrowserDownload,
  keepLocalInPlan,
} from "../browser-download-filing";
import type { BrowserBridgeDownload } from "./bridge";
import {
  type BrowserDownloadOutcome,
  type DownloadProvenance,
  receiveBrowserDownload,
  withProvenance,
} from "./downloads";

/**
 * Each chat's downloads, from the extension's reports until a browser result
 * of the chat hands them to the agent. A settled download is saved into the
 * folder of the chat's run held at the time, at once, or of the next run to
 * take it. A browser step waits a moment for the downloads it started, so
 * a PDF its click or open saved is in that step's own result; one still
 * saving after the wait is counted and listed by a later result, or by
 * `wait_for_downloads`, which waits longer for every one still saving.
 *
 * Each outcome says where the download came from as the chat saw it: the
 * page the chat had read when the download started (`pageOf`), and when
 * it settled.
 */

/**
 * How long a browser result waits for downloads its step started: long
 * enough for a typical PDF to finish and be checked, short enough that a
 * slow one never holds the step.
 */
export const DOWNLOAD_SETTLE_WAIT_MS = 3000;

/** The longest `wait_for_downloads` waits, below the harnesses' tool deadlines. */
export const MAX_DOWNLOAD_WAIT_MS = 45_000;

/**
 * A started download whose report never came (the extension restarted
 * while it ran) stops counting as saving after this long.
 */
const STARTED_DOWNLOAD_TTL_MS = 10 * 60_000;

/** Downloads one chat keeps for its next browser result; older ones go first. */
const MAX_HELD_DOWNLOADS = 16;

/** Started downloads one chat keeps track of; older ones go first. */
const MAX_STARTED_DOWNLOADS = 16;

/** Plan-started deliveries remembered until they settle; older ones go first. */
const MAX_PLAN_DELIVERIES = 64;

/** Outcomes each run remembers by address; older ones go first. */
const MAX_KNOWN_ADDRESSES = 64;

/**
 * The run a result is taken for: whose folder downloads land in, and who
 * files each saved one with stella (none where the run files nothing).
 */
type InboxRun = {
  runId: string;
  threadId: string;
  workspaceDir: string;
  /** In Plan, the run files nothing: neither its downloads nor later ones of the same steps. */
  approvals?: DesktopRunnerApprovalMode | undefined;
  fileDownload?: FileBrowserDownload | undefined;
};

/**
 * A settled download until a result hands it out; see `shownDocument` on
 * the bridge's report. One saved while a run was held belongs to that
 * run: its path is relative to that run's folder, so only that run's
 * results hand it out. One that arrived between runs waits for the next
 * run to take it, which saves it into its own folder. A save still running
 * when a result's bound runs out stays held for a later result.
 */
type HeldDownload = {
  shownDocument: string | null;
  provenance: DownloadProvenance;
  /**
   * A Plan run's step started it: it is saved but never filed, whichever
   * run takes it.
   */
  keepLocal: boolean;
} & (
  | {
      type: "saving";
      outcome: Promise<BrowserDownloadOutcome>;
      /** The save's outcome once it settled; null while it runs. */
      settled: BrowserDownloadOutcome | null;
      runId: string;
    }
  | { type: "waiting"; download: BrowserDownload }
);

type SavingDownload = Extract<HeldDownload, { type: "saving" }>;

/** A held download whose save into `runId`'s folder runs as `saving`. */
const savingEntry = (
  {
    keepLocal,
    provenance,
    shownDocument,
  }: Pick<HeldDownload, "keepLocal" | "provenance" | "shownDocument">,
  runId: string,
  saving: Promise<BrowserDownloadOutcome>,
): SavingDownload => {
  const entry: SavingDownload = {
    keepLocal,
    outcome: saving,
    provenance,
    runId,
    settled: null,
    shownDocument,
    type: "saving",
  };
  entry.outcome = saving.then((outcome) => {
    entry.settled = outcome;
    return outcome;
  });
  return entry;
};

/**
 * Waits until every one of the saves settled, `ms` ran out or `signal`
 * ended, whichever comes first.
 */
const settledWithin = async (
  saves: readonly SavingDownload[],
  { clock, ms, signal }: { clock: InboxClock; ms: number; signal: AbortSignal },
): Promise<void> => {
  if (saves.length === 0 || signal.aborted) {
    return;
  }
  const { promise: ended, resolve: end } = Promise.withResolvers<undefined>();
  const onEnd = () => {
    end(undefined);
  };
  const cancel = clock.schedule(onEnd, ms);
  const onAbort = onEnd;
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([
      Promise.all(saves.map(async ({ outcome }) => await outcome)),
      ended,
    ]);
  } finally {
    cancel();
    signal.removeEventListener("abort", onAbort);
  }
};

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
  /** The page it came from (`DownloadProvenance`). */
  pageUrl: string | null;
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
  /**
   * How long to wait at most; `DOWNLOAD_SETTLE_WAIT_MS` unless given. The
   * wait ends once every download announced after `since` settled.
   */
  waitMs?: number;
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
  /** The address of the page a chat last read, if any. */
  pageOf: (threadId: string) => string | null;
  /** The member's home folder: Chrome saves downloads under it. */
  home: string;
  clock?: InboxClock;
  /** Judges and moves one settled download; `downloads.ts` unless a test stands in. */
  receive?: typeof receiveBrowserDownload;
};

const emptyChat = (): ChatDownloads => ({ held: [], started: new Map() });

/**
 * A settled download as held: saving into `run`'s folder at once (`save`),
 * or waiting for the chat's next run between runs.
 */
const holdSettled = (
  report: Extract<BrowserBridgeDownload, { type: "settled" }>,
  run: InboxRun | null,
  { keepLocal, provenance }: Pick<HeldDownload, "keepLocal" | "provenance">,
  save: (
    download: BrowserDownload,
    run: InboxRun,
    held: Pick<HeldDownload, "keepLocal" | "provenance">,
  ) => Promise<BrowserDownloadOutcome>,
): HeldDownload =>
  run === null
    ? {
        download: report.download,
        keepLocal,
        provenance,
        shownDocument: report.shownDocument,
        type: "waiting",
      }
    : savingEntry(
        { keepLocal, provenance, shownDocument: report.shownDocument },
        run.runId,
        save(report.download, run, { keepLocal, provenance }),
      );

/**
 * The page a reported download comes from (`DownloadProvenance`): a shown
 * PDF's save from the PDF itself, a page's download from the page the chat
 * is on as the report arrives.
 */
const reportedPage = (
  { controllerId, shownDocument }: BrowserBridgeDownload,
  pageOf: InboxOptions["pageOf"],
): string | null =>
  shownDocument === null
    ? pageOf(controllerId)
    : browserDocumentAddress(shownDocument);

/**
 * `page` when the file was fetched from the same origin, else null. The
 * extension reports a download by chat, not by tab, so the page the chat
 * read is only trusted as the file's page when the file came from that
 * page's own site; a file from anywhere else (a page on another site in
 * another tab, a separate file host, a `data:` address, another site's
 * `blob:`) has no page.
 */
const sameOriginPage = (
  page: string | null,
  sourceUrl: string,
): string | null => {
  if (page === null || !URL.canParse(page) || !URL.canParse(sourceUrl)) {
    return null;
  }
  const origin = new URL(page).origin;
  return origin !== "null" && origin === new URL(sourceUrl).origin
    ? page
    : null;
};

/**
 * Waits while `saving` holds: it is checked again on every report
 * (`listeners`), and the wait ends after `waitMs` or with `signal` anyway.
 */
const waitWhile = async (
  saving: () => boolean,
  {
    clock,
    listeners,
    signal,
    waitMs,
  }: {
    clock: InboxClock;
    listeners: Set<() => void>;
    signal: AbortSignal;
    waitMs: number;
  },
): Promise<void> => {
  if (!saving() || signal.aborted) {
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
      if (!saving()) {
        done();
      }
    };
    const cancel = clock.schedule(done, waitMs);
    listeners.add(check);
    signal.addEventListener("abort", done, { once: true });
  });
};

/** Whether one of `entries` saves the document at `address`. */
const showsAny = (
  address: string | null,
  entries: readonly { shownDocument: string | null }[],
): boolean =>
  address !== null &&
  entries.some(
    ({ shownDocument }) =>
      shownDocument !== null &&
      browserDocumentAddress(shownDocument) === address,
  );

/**
 * Saves one settled download into `run`'s folder, then files a saved one
 * with stella when the run files downloads: a result that waits for the
 * save waits for the filing too, within its bound.
 */
const saveAndFile = async ({
  download,
  home,
  keepLocal,
  provenance,
  receiveDownload,
  run,
}: {
  download: BrowserDownload;
  home: string;
  keepLocal: boolean;
  provenance: DownloadProvenance;
  receiveDownload: typeof receiveBrowserDownload;
  run: InboxRun;
}): Promise<BrowserDownloadOutcome> => {
  const outcome = withProvenance(
    await receiveDownload(download, { home, workspaceDir: run.workspaceDir }),
    provenance,
  );
  if (outcome.status !== "saved" || run.fileDownload === undefined) {
    return outcome;
  }
  // The policy of the run whose step started it, not of the run that saves it.
  const file = keepLocal ? keepLocalInPlan : run.fileDownload;
  const filed = await file({
    origin: {
      downloadedAt: outcome.downloadedAt,
      pageUrl: outcome.pageUrl,
      sourceUrl: outcome.sourceUrl,
    },
    path: outcome.path,
    sha256: outcome.sha256,
  });
  return { ...outcome, filed };
};

/**
 * The deliveries a Plan run's step started, each until it settles: not
 * tied to the run, so its end does not drop them.
 */
const createPlanDeliveries = () => {
  let started = new Set<string>();
  return {
    start: (deliveryId: string): void => {
      started = new Set([...started, deliveryId].slice(-MAX_PLAN_DELIVERIES));
    },
    /** Whether a Plan run's step started it; it is forgotten either way. */
    settle: (deliveryId: string): boolean => started.delete(deliveryId),
  };
};

/** The newest `limit` entries of a map, in insertion order. */
const newest = <K, V>(map: Map<K, V>, limit: number): Map<K, V> =>
  new Map([...map].slice(-limit));

export const createDownloadInbox = ({
  clock = systemInboxClock,
  home,
  pageOf,
  receive: receiveDownload = receiveBrowserDownload,
  runOf,
}: InboxOptions) => {
  const chats = new Map<string, ChatDownloads>();
  /** What each run's documents became, by address: repeated on a later read. */
  const known = new Map<string, Map<string, BrowserDownloadOutcome>>();
  /** Called whenever a chat's report arrives. */
  const listeners = new Set<() => void>();
  const planDeliveries = createPlanDeliveries();
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

  const receive = async (
    download: BrowserDownload,
    run: InboxRun,
    held: Pick<HeldDownload, "keepLocal" | "provenance">,
  ) => await saveAndFile({ ...held, download, home, receiveDownload, run });

  const nowIso = () =>
    Temporal.Instant.fromEpochMilliseconds(clock.now()).toString();

  /** The downloads still saving that `runId`'s results may count. */
  const savingFor = (chat: ChatDownloads, runId: string): Started[] =>
    [...chat.started.values()].filter(
      (started) => started.runId === null || started.runId === runId,
    );

  /** Whether a download announced after `since` that `run` may count is still saving. */
  const stillSaving = (run: InboxRun, since: number): boolean =>
    savingFor(chatOf(run.threadId), run.runId).some(
      ({ sequence }) => sequence > since,
    );

  /** Waits until the downloads announced after `since` settled, `waitMs` ran out or `signal` ended. */
  const settle = async (
    run: InboxRun,
    since: number,
    signal: AbortSignal,
    waitMs: number,
  ): Promise<void> => {
    await waitWhile(() => stillSaving(run, since), {
      clock,
      listeners,
      signal,
      waitMs,
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
        case "started": {
          announced += 1;
          if (runOf(report.controllerId)?.approvals === "plan") {
            planDeliveries.start(report.deliveryId);
          }
          chat.started.set(report.deliveryId, {
            at: clock.now(),
            pageUrl: reportedPage(report, pageOf),
            runId: runOf(report.controllerId)?.runId ?? null,
            sequence: announced,
            shownDocument:
              report.shownDocument === null
                ? null
                : browserDocumentAddress(report.shownDocument),
          });
          chat.started = newest(chat.started, MAX_STARTED_DOWNLOADS);
          return;
        }
        case "settled": {
          const announcement = chat.started.get(report.deliveryId);
          chat.started.delete(report.deliveryId);
          // One stopped before it started was never announced: it comes
          // from the page the chat is on now.
          const page =
            announcement === undefined
              ? reportedPage(report, pageOf)
              : announcement.pageUrl;
          const held = holdSettled(
            report,
            runOf(report.controllerId),
            {
              // Kept past the end of its run: `forgetRun` leaves it.
              keepLocal: planDeliveries.settle(report.deliveryId),
              provenance: {
                at: nowIso(),
                pageUrl: sameOriginPage(page, report.download.sourceUrl),
              },
            },
            receive,
          );
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
      {
        shownAddress,
        signal,
        since,
        waitMs = DOWNLOAD_SETTLE_WAIT_MS,
      }: TakeOptions,
    ): Promise<TakenDownloads> => {
      const begun = clock.now();
      await settle(run, since, signal, waitMs);
      const chat = chatOf(run.threadId);
      // Off the list at once, so no other result hands them out too; one
      // that waited for a run starts saving into this run's folder now.
      const taken = chat.held.filter((entry) => heldFor(entry, run.runId));
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
      const held = taken.map((entry) =>
        entry.type === "waiting"
          ? savingEntry(entry, run.runId, receive(entry.download, run, entry))
          : entry,
      );
      // The saves get what is left of this result's bound, and no more; one
      // still running is held again for a later result.
      await settledWithin(held, {
        clock,
        ms: Math.max(0, waitMs - (clock.now() - begun)),
        signal,
      });
      const unsaved = held.filter((entry) => entry.settled === null);
      chat.held = [...unsaved, ...chat.held].slice(-MAX_HELD_DOWNLOADS);
      const shownSaving = showsAny(shownDocument, [...saving, ...unsaved]);
      const settled = held.flatMap(
        ({ settled: outcome, shownDocument: shown }) =>
          outcome === null ? [] : [{ outcome, shownDocument: shown }],
      );
      remember(run.runId, settled);
      return {
        downloads: settled.map(({ outcome }) => outcome),
        saving: saving.length + unsaved.length,
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
