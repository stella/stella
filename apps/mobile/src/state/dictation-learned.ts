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

export const writeLearnedFixes = async (
  store: AccountStore,
  account: AccountKeys,
  fixes: readonly LearnedFix[],
): Promise<void> => {
  await (fixes.length === 0
    ? store.remove(learnedKey(account))
    : store.write(learnedKey(account), JSON.stringify(fixes)));
};

/** Deletes the ending session's learned fixes from the device. */
export const forgetLearnedFixes =
  (store: AccountStore): BeforeSessionEnd =>
  async (_reason, session) => {
    await store.remove(learnedKey(session));
  };
