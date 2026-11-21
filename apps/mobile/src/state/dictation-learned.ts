import * as v from "valibot";

import {
  LEARNED_FIX_LIMIT,
  LEARNED_FIX_STATUSES,
  LEARNED_FIX_TEXT_LIMIT,
} from "@stll/transcript/corrections";
import type { LearnedFix } from "@stll/transcript/corrections";

import type { BeforeSessionEnd } from "@/connection/session-end";
import type { AccountStore } from "@/state/recent-searches";
import { keyPart } from "@/state/recent-searches";

/**
 * The fixes stella learned from how this account corrects dictated words on
 * this phone, kept in the keychain per server and person like the
 * dictation choices, forgotten at sign-out, never sent anywhere.
 */
const fixText = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(LEARNED_FIX_TEXT_LIMIT),
);
const learnedSchema = v.pipe(
  v.array(
    v.object({
      from: fixText,
      to: fixText,
      seen: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
      status: v.picklist(LEARNED_FIX_STATUSES),
    }),
  ),
  v.maxLength(LEARNED_FIX_LIMIT),
);

type AccountKeys = { readonly serverUrl: string; readonly userId: string };

const learnedKey = ({ serverUrl, userId }: AccountKeys): string =>
  `dictation-learned.${keyPart(serverUrl)}.${keyPart(userId)}`;

/** What the phone learned, or nothing when it kept nothing this build reads. */
export const readLearnedFixes = async (
  store: AccountStore,
  account: AccountKeys,
): Promise<LearnedFix[]> => {
  const stored = await store.read(learnedKey(account));
  if (stored === null) {
    return [];
  }
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), learnedSchema),
    stored,
  );
  return parsed.success ? parsed.output : [];
};

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
 * Changes the learned fixes as one read and write, after any change still
 * under way for the account; the fixes as written. Nothing is written once
 * the sign-in has signed out.
 */
export const updateLearnedFixes = async (
  store: AccountStore,
  signIn: SignIn,
  change: (fixes: LearnedFix[]) => LearnedFix[],
): Promise<LearnedFix[]> =>
  await queued(learnedKey(signIn), async () => {
    const fixes = await readLearnedFixes(store, signIn);
    const next = change(fixes);
    if (
      signedOut.has(signIn.signInId) ||
      JSON.stringify(next) === JSON.stringify(fixes)
    ) {
      return fixes;
    }
    await (next.length === 0
      ? store.remove(learnedKey(signIn))
      : store.write(learnedKey(signIn), JSON.stringify(next)));
    return next;
  });

/** Deletes the learned fixes, after any change under way; works when they cannot be read. */
export const deleteLearnedFixes = async (
  store: AccountStore,
  signIn: SignIn,
): Promise<void> => {
  await queued(learnedKey(signIn), async () => {
    await store.remove(learnedKey(signIn));
  });
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
