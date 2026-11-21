import { panic } from "better-result";
import type { Result } from "better-result";

import type { Dictated } from "@/state/dictation";
import {
  keptFor,
  recordingsToTranscribe,
  RECOVERED_OFFER_MS,
  retriesByItself,
  retryDelayMs,
  stillOffered,
} from "@/state/dictation-kept";
import type {
  DictationField,
  KeptDictation,
  KeptPiece,
  PieceFailure,
} from "@/state/dictation-kept";

/** Where kept dictations live on the phone (`native/kept-dictation-files`). */
export type KeptFiles = {
  readonly list: () => Promise<Result<KeptDictation[], unknown>>;
  /** Each says whether it was done. */
  readonly keep: (
    kept: KeptDictation,
    recordings: readonly { readonly file: string; readonly uri: string }[],
  ) => boolean;
  readonly update: (kept: KeptDictation) => boolean;
  readonly removeRecording: (id: string, file: string) => boolean;
  readonly forget: (id: string) => boolean;
};

/** What one retry of a waiting dictation came to. */
export type RetryOutcome =
  /** Every piece has its text, joined and tidied as the person chose. */
  | { readonly type: "transcribed"; readonly dictated: Dictated }
  /** Every piece has its text, and none has words. */
  | { readonly type: "silent" }
  /** Some recordings are still without text: `pieces` keeps those that have one. */
  | {
      readonly type: "failed";
      readonly pieces: readonly KeptPiece[];
      readonly error: PieceFailure;
    };

export type WaitingDictation = KeptDictation & {
  readonly state: {
    readonly type: "waiting";
    readonly pieces: readonly KeptPiece[];
    readonly refused: boolean;
  };
};

/** Where a kept dictation stands, as a field shows it. */
type KeptStatus =
  /** Waiting to be tried again by itself. */
  | "waiting"
  | "retrying"
  /** Refused, or unreadable: only the person's retry or discard moves it. */
  | "needs-person"
  /** Transcribed after its field closed: offered for pasting. */
  | "recovered";

export type KeptView = {
  readonly id: string;
  readonly field: DictationField;
  /** The open field it goes to once transcribed; null with that field closed. */
  readonly owner: string | null;
  readonly status: KeptStatus;
};

/** A finished dictation's pieces, as `keep` takes them. */
export type FinishedPiece =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "audio"; readonly uri: string };

/** What a kept dictation is transcribed with, as when it was recorded. */
export type KeptSetup = {
  readonly field: DictationField;
  readonly matterId: string | null;
  readonly modelId: string | null;
  readonly locale: string;
  readonly cleanup: boolean;
};

type KeptDictationsDeps = {
  readonly account: { readonly serverUrl: string; readonly userId: string };
  readonly files: KeptFiles;
  /** Transcribes a waiting dictation's recordings that have no text yet. */
  readonly retry: (kept: WaitingDictation) => Promise<RetryOutcome>;
  readonly now: () => number;
  /** Runs `run` after `ms`; the returned function cancels it. */
  readonly later: (run: () => void, ms: number) => () => void;
  readonly newId: () => string;
};

type Entry = {
  kept: KeptDictation;
  retrying: boolean;
  /** Tries by itself that failed in a row. */
  failures: number;
  needsPerson: boolean;
  cancelTimer: (() => void) | null;
  /** The retry under way, which a later ask waits for instead of starting another. */
  inFlight: Promise<void> | null;
};

/** What the store's helpers share. */
type Store = {
  readonly deps: KeptDictationsDeps;
  readonly entries: Map<string, Entry>;
  /** Open fields, each with where its texts go; false while it takes none. */
  readonly owners: Map<string, (dictated: Dictated) => boolean>;
  /** The field each kept dictation was dictated into. */
  readonly ownerOf: Map<string, string>;
  readonly publish: () => void;
  stopped: boolean;
};

export type KeptDictations = ReturnType<typeof createKeptDictations>;

/**
 * The signed-in account's kept dictations (`state/dictation-kept`): what
 * fields show and the retries that move them on. A field registers as an
 * owner while it is open; a dictation it keeps goes to it once transcribed,
 * and to the paste offer when it has closed meanwhile.
 */
export const createKeptDictations = (deps: KeptDictationsDeps) => {
  const listeners = new Set<() => void>();
  let views: readonly KeptView[] = [];
  const store: Store = {
    deps,
    entries: new Map(),
    owners: new Map(),
    ownerOf: new Map(),
    publish: () => {
      views = viewsOf(store);
      for (const listener of listeners) {
        listener();
      }
    },
    stopped: false,
  };

  return {
    /**
     * Reads what an earlier run kept for the account and drops offers that
     * ran out. Whether the phone could list them.
     */
    load: async (): Promise<boolean> => await loadKept(store),

    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    views: (): readonly KeptView[] => views,

    /**
     * An open field, which gets the text of each dictation it keeps. While
     * it takes none (`deliver` says false, as while its draft is sent), the
     * text is offered for pasting instead.
     */
    own: (owner: string, deliver: (dictated: Dictated) => boolean) => {
      store.owners.set(owner, deliver);
      store.publish();
      return () => {
        store.owners.delete(owner);
        store.publish();
      };
    },

    /**
     * Keeps a dictation some of whose recordings could not be transcribed,
     * moving them into its folder; it then retries by itself unless
     * `refused`. Whether it was kept: if not, the recordings are where they
     * were.
     */
    keep: (args: KeepArgs): boolean => keepFinished(store, args),

    /**
     * Hands a finished dictation's text to its field, or offers it for
     * pasting when the field closed while it was transcribed.
     */
    deliver: ({
      owner,
      setup,
      dictated,
    }: {
      owner: string;
      setup: KeptSetup;
      dictated: Dictated;
    }) => {
      if (store.owners.get(owner)?.(dictated) !== true) {
        offerText(store, setup, dictated);
      }
    },

    /** The person's retry: also of a dictation that waits for them. */
    retry: async (ids: readonly string[]) => {
      await Promise.all(
        ids.map(async (id) => {
          const entry = store.entries.get(id);
          if (entry !== undefined) {
            entry.needsPerson = false;
            await retryEntry(store, entry);
          }
        }),
      );
    },

    /** Tries every dictation that retries by itself, as the phone comes online or back to the front. */
    retryWaiting: async () => {
      await Promise.all(
        [...store.entries.values()]
          .filter(({ needsPerson }) => !needsPerson)
          .map(async (entry) => {
            await retryEntry(store, entry);
          }),
      );
    },

    discard: (ids: readonly string[]) => {
      for (const id of ids) {
        drop(store, id);
      }
      store.publish();
    },

    /** The recovered text, gone from the offer once taken. */
    take: (id: string): Dictated | undefined => {
      const kept = store.entries.get(id)?.kept;
      if (kept?.state.type !== "recovered") {
        return undefined;
      }
      drop(store, id);
      store.publish();
      return { text: kept.state.text, names: kept.state.names };
    },

    stop: () => {
      store.stopped = true;
      for (const entry of store.entries.values()) {
        entry.cancelTimer?.();
        entry.cancelTimer = null;
      }
      listeners.clear();
    },
  };
};

const viewsOf = ({ entries, owners, ownerOf }: Store): KeptView[] =>
  [...entries.values()].map(({ kept, retrying, needsPerson }) => {
    const owner = ownerOf.get(kept.id);
    return {
      id: kept.id,
      field: kept.field,
      owner: owner !== undefined && owners.has(owner) ? owner : null,
      status: statusOf(kept, retrying, needsPerson),
    };
  });

const newEntry = (kept: KeptDictation, failures: number): Entry => ({
  kept,
  retrying: false,
  failures,
  needsPerson: false,
  cancelTimer: null,
  inFlight: null,
});

const loadKept = async (store: Store): Promise<boolean> => {
  const listed = await store.deps.files.list();
  if (listed.isErr()) {
    return false;
  }
  const now = store.deps.now();
  for (const kept of listed.value) {
    if (!keptFor(kept, store.deps.account) || store.entries.has(kept.id)) {
      continue;
    }
    if (kept.state.type === "recovered" && !stillOffered(kept, now)) {
      store.deps.files.forget(kept.id);
      continue;
    }
    const entry = newEntry(kept, 0);
    // A refusal stays one across launches: it waits for the person.
    entry.needsPerson = kept.state.type === "waiting" && kept.state.refused;
    store.entries.set(kept.id, entry);
    offer(store, entry);
  }
  store.publish();
  return true;
};

type KeepArgs = {
  readonly owner: string;
  readonly setup: KeptSetup;
  readonly pieces: readonly FinishedPiece[];
  readonly refused: boolean;
};

const keepFinished = (
  store: Store,
  { owner, setup, pieces, refused }: KeepArgs,
): boolean => {
  const { deps } = store;
  // Signed out meanwhile: nothing of the account stays on the phone.
  if (store.stopped) {
    return false;
  }
  const recordings: { file: string; uri: string }[] = [];
  const kept: KeptDictation = {
    id: deps.newId(),
    serverUrl: deps.account.serverUrl,
    userId: deps.account.userId,
    ...setup,
    keptAt: deps.now(),
    state: {
      type: "waiting",
      refused,
      pieces: pieces.map((piece, index) => {
        if (piece.type === "text") {
          return piece;
        }
        const file = `${index}.m4a`;
        recordings.push({ file, uri: piece.uri });
        return { type: "audio", file };
      }),
    },
  };
  if (!deps.files.keep(kept, recordings)) {
    return false;
  }
  // The try that just failed counts: the next waits as after one failure.
  const entry = newEntry(kept, 1);
  entry.needsPerson = refused;
  store.entries.set(kept.id, entry);
  store.ownerOf.set(kept.id, owner);
  if (!refused) {
    scheduleRetry(store, entry);
  }
  store.publish();
  return true;
};

/** Keeps a finished text whose field has closed, and offers it. */
const offerText = (
  store: Store,
  setup: KeptSetup,
  { text, names }: Dictated,
) => {
  const { deps } = store;
  if (store.stopped) {
    return;
  }
  const recoveredAt = deps.now();
  const kept: KeptDictation = {
    id: deps.newId(),
    serverUrl: deps.account.serverUrl,
    userId: deps.account.userId,
    ...setup,
    keptAt: recoveredAt,
    state: { type: "recovered", text, names, recoveredAt },
  };
  if (deps.files.keep(kept, [])) {
    const entry = newEntry(kept, 0);
    store.entries.set(kept.id, entry);
    offer(store, entry);
    store.publish();
  }
};

const drop = (store: Store, id: string) => {
  store.entries.get(id)?.cancelTimer?.();
  store.entries.delete(id);
  store.ownerOf.delete(id);
  store.deps.files.forget(id);
};

const scheduleRetry = (store: Store, entry: Entry) => {
  entry.cancelTimer = store.deps.later(() => {
    entry.cancelTimer = null;
    void retryEntry(store, entry);
  }, retryDelayMs(entry.failures));
};

/** Offers a recovered text for pasting until its offer runs out. */
const offer = (store: Store, entry: Entry) => {
  const { kept } = entry;
  if (kept.state.type !== "recovered") {
    return;
  }
  const left = kept.state.recoveredAt + RECOVERED_OFFER_MS - store.deps.now();
  entry.cancelTimer?.();
  entry.cancelTimer = store.deps.later(
    () => {
      drop(store, kept.id);
      store.publish();
    },
    Math.max(0, left),
  );
};

/** A transcribed text goes to its open field, else it is offered. */
const settle = (store: Store, entry: Entry, dictated: Dictated) => {
  const previous = entry.kept;
  const owner = store.ownerOf.get(previous.id);
  const deliver = owner === undefined ? undefined : store.owners.get(owner);
  if (deliver?.(dictated) === true) {
    drop(store, previous.id);
    return;
  }
  const recovered: KeptDictation = {
    id: previous.id,
    serverUrl: previous.serverUrl,
    userId: previous.userId,
    field: previous.field,
    matterId: previous.matterId,
    modelId: previous.modelId,
    locale: previous.locale,
    cleanup: previous.cleanup,
    keptAt: previous.keptAt,
    state: {
      type: "recovered",
      text: dictated.text,
      names: dictated.names,
      recoveredAt: store.deps.now(),
    },
  };
  entry.kept = recovered;
  store.ownerOf.delete(recovered.id);
  // The recordings go only once the text is written, so the phone never
  // holds a description of recordings it no longer has.
  if (store.deps.files.update(recovered)) {
    removeRecordings(store.deps, previous, []);
  }
  offer(store, entry);
};

/** Deletes the recordings `before` had that `after` no longer needs. */
const removeRecordings = (
  deps: KeptDictationsDeps,
  before: KeptDictation,
  after: readonly KeptPiece[],
) => {
  if (before.state.type !== "waiting") {
    return;
  }
  const still = new Set(recordingsToTranscribe(after));
  for (const file of recordingsToTranscribe(before.state.pieces)) {
    if (!still.has(file)) {
      deps.files.removeRecording(before.id, file);
    }
  }
};

/** Retries a waiting dictation, or waits for the retry already under way. */
const retryEntry = async (store: Store, entry: Entry) => {
  entry.inFlight ??= runRetry(store, entry).finally(() => {
    entry.inFlight = null;
  });
  await entry.inFlight;
};

const runRetry = async (store: Store, entry: Entry) => {
  const { kept } = entry;
  if (kept.state.type !== "waiting") {
    return;
  }
  const waiting: WaitingDictation = { ...kept, state: kept.state };
  entry.retrying = true;
  entry.cancelTimer?.();
  entry.cancelTimer = null;
  store.publish();
  const outcome = await store.deps.retry(waiting);
  entry.retrying = false;
  // Discarded, or the account signed out, while it was transcribed.
  if (store.stopped || store.entries.get(kept.id) !== entry) {
    store.publish();
    return;
  }
  switch (outcome.type) {
    case "transcribed":
      settle(store, entry, outcome.dictated);
      break;
    case "silent":
      drop(store, kept.id);
      break;
    case "failed": {
      const refused = !retriesByItself(outcome.error);
      const moved: KeptDictation = {
        ...kept,
        state: { type: "waiting", pieces: outcome.pieces, refused },
      };
      entry.kept = moved;
      if (store.deps.files.update(moved)) {
        removeRecordings(store.deps, kept, outcome.pieces);
      }
      entry.needsPerson = refused;
      entry.failures += 1;
      if (!entry.needsPerson) {
        scheduleRetry(store, entry);
      }
      break;
    }
    default:
      outcome satisfies never;
      panic("A retry came to no known outcome");
  }
  store.publish();
};

const statusOf = (
  kept: KeptDictation,
  retrying: boolean,
  needsPerson: boolean,
): KeptStatus => {
  if (kept.state.type === "recovered") {
    return "recovered";
  }
  if (retrying) {
    return "retrying";
  }
  return needsPerson ? "needs-person" : "waiting";
};
