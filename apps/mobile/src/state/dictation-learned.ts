import { panic } from "better-result";
import * as v from "valibot";

import {
  DICTATION_LEARNED_FIX_LIMITS,
  DICTATION_LEARNED_FIXES_PATH,
  dictationLearnedFixChangeSchema,
  dictationLearnedFixesSchema,
  dictationLearnedFixSchema,
} from "@stll/api-contract/dictation-learned-fixes";
import type {
  DictationLearnedFixChange,
  DictationLearnedFixes,
} from "@stll/api-contract/dictation-learned-fixes";
import { applyLearnedFixChanges } from "@stll/transcript/learned-fixes";
import type {
  LearnedFix,
  LearnedFixChange,
} from "@stll/transcript/learned-fixes";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import type { BeforeSessionEnd } from "@/connection/session-end";
import { requestApi } from "@/state/api-request";
import type { AccountStore } from "@/state/recent-searches";
import { keyPart } from "@/state/recent-searches";

/**
 * The fixes stella learned from how this account corrects dictated words,
 * kept in the keychain per server and person like the dictation choices and
 * forgotten at sign-out. The phone learns on its own copy and sends what it
 * learned, as changes, to the account's copy on the server, which every
 * device of the person's applies the same way (`@stll/transcript/learned-
 * fixes`); only that person can read it. A server without it, or one that
 * cannot be reached, leaves the phone learning on its own until it can.
 */
const storedSchema = v.object({
  generation: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  fixes: v.pipe(
    v.array(dictationLearnedFixSchema),
    v.maxLength(DICTATION_LEARNED_FIX_LIMITS.fixes),
  ),
  /**
   * The id this phone's changes go out under, made with its first change.
   * Kept in the same entry as `seq`, so the two are only ever lost together:
   * an id kept with a lost count would number new changes the server already
   * counted, and it would drop them.
   */
  device: v.nullable(v.pipe(v.string(), v.uuid())),
  /** The number of the last change made here; the next one is one more. */
  seq: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /** Changes not yet sent, in the order they were made. */
  pending: v.array(dictationLearnedFixChangeSchema),
  /** Everything was deleted here; the server's copy is deleted first. */
  clearPending: v.boolean(),
});

type Stored = v.InferOutput<typeof storedSchema>;

/** What an earlier build kept: the fixes alone, learned on this phone only. */
const phoneOnlySchema = v.pipe(
  v.array(dictationLearnedFixSchema),
  v.maxLength(DICTATION_LEARNED_FIX_LIMITS.fixes),
);

const EMPTY: Stored = {
  generation: 0,
  fixes: [],
  device: null,
  seq: 0,
  pending: [],
  clearPending: false,
};

/** Changes kept to send, at most; past it the oldest are let go. */
const PENDING_LIMIT = 200;

type AccountKeys = { readonly serverUrl: string; readonly userId: string };

const learnedKey = ({ serverUrl, userId }: AccountKeys): string =>
  `dictation-learned.${keyPart(serverUrl)}.${keyPart(userId)}`;

/**
 * The changes that rebuild fixes learned on this phone alone: a fix in use
 * is taught, one being learned is seen once, and the rest keep the status
 * they had.
 */
const changesRebuilding = (fixes: readonly LearnedFix[]): LearnedFixChange[] =>
  fixes.flatMap(({ from, to, status }): LearnedFixChange[] => {
    switch (status) {
      case "learning": {
        return [{ type: "corrected", from, to }];
      }
      case "on": {
        return [{ type: "taught", from, to }];
      }
      case "off": {
        return [
          { type: "taught", from, to },
          { type: "switched", from, status: "off" },
        ];
      }
      case "contradicted": {
        return [
          { type: "corrected", from, to },
          { type: "kept", from },
        ];
      }
      default: {
        status satisfies never;
        return panic("Unknown learned fix status");
      }
    }
  });

/** What `kept`, as the keychain holds it, stores; an earlier build's fixes become changes to send. */
const parseStored = (kept: string | null, newId: () => string): Stored => {
  if (kept === null) {
    return EMPTY;
  }
  const json = v.safeParse(v.pipe(v.string(), v.parseJson()), kept);
  if (!json.success) {
    return EMPTY;
  }
  const stored = v.safeParse(storedSchema, json.output);
  if (stored.success) {
    return stored.output;
  }
  const phoneOnly = v.safeParse(phoneOnlySchema, json.output);
  return phoneOnly.success
    ? queue(
        { ...EMPTY, fixes: phoneOnly.output },
        changesRebuilding(phoneOnly.output),
        newId,
      )
    : EMPTY;
};

/**
 * `stored` with `changes` numbered after its last one and kept to send; the
 * phone's id is made with its first change.
 */
const queue = (
  stored: Stored,
  changes: readonly LearnedFixChange[],
  newId: () => string,
): Stored => {
  const numbered = changes
    .map((change, index) => ({ ...change, seq: stored.seq + index + 1 }))
    // A change the server would refuse would hold back every later one.
    .filter((change) => v.is(dictationLearnedFixChangeSchema, change));
  const last = numbered.at(-1);
  if (last === undefined) {
    return stored;
  }
  return {
    ...stored,
    device: stored.device ?? newId(),
    seq: last.seq,
    pending: [...stored.pending, ...numbered].slice(-PENDING_LIMIT),
  };
};

/** What the phone learned, or nothing when it kept nothing this build reads. */
export const readLearnedFixes = async (
  store: AccountStore,
  account: AccountKeys,
): Promise<LearnedFix[]> =>
  parseStored(await store.read(learnedKey(account)), () => "").fixes;

type SignIn = AccountKeys & { readonly signInId: string };

/**
 * Each account's last change to its learned fixes, so the next one reads
 * what that one wrote, and sign-out's removal waits for it.
 */
const queues = new Map<string, Promise<unknown>>();
/** Sign-ins whose fixes were removed at sign-out: nothing is written for them again. */
const signedOut = new Set<string>();

const queued = async <T>(key: string, step: () => Promise<T>): Promise<T> => {
  const done = (queues.get(key) ?? Promise.resolve()).then(step, step);
  queues.set(
    key,
    done.catch(() => undefined),
  );
  return await done;
};

/**
 * Reads, changes and writes the stored fixes as one step, after any step
 * still under way for the account; what is stored after. Nothing is
 * written once the sign-in has signed out.
 */
const rewrite = async (
  store: AccountStore,
  signIn: SignIn,
  newId: () => string,
  change: (stored: Stored) => Stored,
): Promise<Stored> =>
  await queued(learnedKey(signIn), async () => {
    const raw = await store.read(learnedKey(signIn));
    const kept = parseStored(raw, newId);
    if (signedOut.has(signIn.signInId)) {
      return kept;
    }
    const next = change(kept);
    const text = JSON.stringify(next);
    if (text === JSON.stringify(EMPTY)) {
      if (raw !== null) {
        await store.remove(learnedKey(signIn));
      }
    } else if (text !== raw) {
      // Also an earlier build's fixes, so their changes keep their ids.
      await store.write(learnedKey(signIn), text);
    }
    return next;
  });

/**
 * Applies what the person did, as changes to the fixes as kept now, and
 * keeps the changes to send; the fixes as written.
 */
export const updateLearnedFixes = async (
  store: AccountStore,
  signIn: SignIn,
  newId: () => string,
  learn: (fixes: readonly LearnedFix[]) => readonly LearnedFixChange[],
): Promise<LearnedFix[]> =>
  (
    await rewrite(store, signIn, newId, (kept) => {
      const next = queue(kept, learn(kept.fixes), newId);
      const added = next.pending.filter(({ seq }) => seq > kept.seq);
      return added.length === 0
        ? kept
        : { ...next, fixes: applyLearnedFixChanges(kept.fixes, added) };
    })
  ).fixes;

/**
 * Deletes the learned fixes here at once, and on the server at the next
 * sync; works when they cannot be read.
 */
export const deleteLearnedFixes = async (
  store: AccountStore,
  signIn: SignIn,
): Promise<void> => {
  await rewrite(
    store,
    signIn,
    () => "",
    (kept) => ({
      ...EMPTY,
      generation: kept.generation,
      // The count goes on: the server knows this phone's earlier numbers.
      device: kept.device,
      seq: kept.seq,
      clearPending: true,
    }),
  );
};

/** Deletes the ending session's learned fixes from the device, after any change under way. */
export const forgetLearnedFixes =
  (store: AccountStore): BeforeSessionEnd =>
  async (_reason, session) => {
    signedOut.add(session.signInId);
    await queued(learnedKey(session), async () => {
      await store.remove(learnedKey(session));
    });
  };

type SyncOptions = {
  readonly store: AccountStore;
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly newId: () => string;
};

/** Rounds one sync takes at most: a long queue waits for the next one. */
const SYNC_ROUNDS = 5;

type Asked =
  | { readonly method: "DELETE"; readonly generation: number }
  | {
      readonly method: "POST";
      readonly generation: number;
      readonly device: string;
      readonly changes: readonly DictationLearnedFixChange[];
    }
  | { readonly method: "GET"; readonly generation: number };

const ask = async (
  { fetch, source }: SyncOptions,
  asked: Asked,
): Promise<DictationLearnedFixes | undefined> => {
  const answered = await requestApi({
    fetch,
    source,
    // A deletion names the generation it deletes, so a retried one cannot
    // take what another device learned after it.
    path:
      asked.method === "DELETE"
        ? `${DICTATION_LEARNED_FIXES_PATH}?generation=${String(asked.generation)}`
        : DICTATION_LEARNED_FIXES_PATH,
    schema: dictationLearnedFixesSchema,
    method: asked.method,
    ...(asked.method === "POST"
      ? {
          body: {
            generation: asked.generation,
            device: asked.device,
            changes: asked.changes,
          },
        }
      : {}),
  });
  // An older server (404), no connection, or a refusal: try again later.
  return answered.isOk() ? answered.value : undefined;
};

/** Which request a sync round makes for what is stored. */
const nextAsk = (stored: Stored): Asked => {
  if (stored.clearPending) {
    return { method: "DELETE", generation: stored.generation };
  }
  if (stored.pending.length === 0 || stored.device === null) {
    return { method: "GET", generation: stored.generation };
  }
  return {
    method: "POST",
    generation: stored.generation,
    device: stored.device,
    changes: stored.pending.slice(
      0,
      DICTATION_LEARNED_FIX_LIMITS.changesPerRequest,
    ),
  };
};

/**
 * What is stored once the server answered `asked`, given what was stored
 * meanwhile: sent changes are dropped from those to send, and the server's
 * fixes are taken unless more were learned here since.
 */
const afterAnswer = (
  kept: Stored,
  asked: Asked,
  answer: DictationLearnedFixes,
): Stored => {
  // Deleted here while the request was out: the deletion goes first.
  if (asked.method !== "DELETE" && kept.clearPending) {
    return kept;
  }
  if (asked.method !== "DELETE" && answer.generation !== asked.generation) {
    // Deleted on another device: what was learned here before went with it,
    // also what was learned while this request was out.
    return {
      ...EMPTY,
      generation: answer.generation,
      fixes: answer.fixes,
      device: kept.device,
      seq: kept.seq,
    };
  }
  const sent = asked.method === "POST" ? (asked.changes.at(-1)?.seq ?? 0) : 0;
  // Changes made since the request went out, or after a deletion here.
  const pending = kept.pending.filter(({ seq }) => seq > sent);
  return {
    ...kept,
    generation: answer.generation,
    fixes:
      pending.length === 0
        ? answer.fixes
        : applyLearnedFixChanges(answer.fixes, pending),
    pending,
    clearPending: false,
  };
};

/**
 * Sends what was learned here and takes what the person's other devices
 * taught: the server deletes first when everything was deleted here, then
 * applies the changes not yet sent, and its answer is what every device
 * holds. Best effort; the fixes as stored after.
 */
export const syncLearnedFixes = async (
  options: SyncOptions,
): Promise<LearnedFix[] | undefined> => {
  const session = options.source.session();
  if (session === undefined) {
    return undefined;
  }
  // One sync at a time per account; one asked for meanwhile runs after it.
  return await queued(`${learnedKey(session)}#sync`, async () => {
    const { store, newId } = options;
    let last: Stored | undefined;
    for (let round = 0; round < SYNC_ROUNDS; round += 1) {
      // Read again each round, as a change may come in between; an earlier
      // build's fixes are stored as changes first, so a retry sends the same.
      const asked = nextAsk(
        await rewrite(store, session, newId, (kept) => kept),
      );
      const answer = await ask(options, asked);
      if (answer === undefined) {
        return last?.fixes;
      }
      last = await rewrite(store, session, newId, (kept) =>
        afterAnswer(kept, asked, answer),
      );
      if (asked.method === "GET" || nextAsk(last).method === "GET") {
        return last.fixes;
      }
    }
    return last?.fixes;
  });
};
