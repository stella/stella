import * as v from "valibot";

import type { BeforeSessionEnd } from "@/connection/session-end";
import type { AccountStore } from "@/state/recent-searches";
import { keyPart } from "@/state/recent-searches";

/**
 * How this account dictates on this phone: the model it picked, absent for
 * the one the server offers by default, and whether stella AI tidies the
 * text before it lands in the box. Kept per server and person, like recent
 * searches, and forgotten at sign-out.
 */
export type DictationPreferences = {
  readonly modelId: string | null;
  readonly cleanup: boolean;
};

export const DEFAULT_DICTATION_PREFERENCES: DictationPreferences = {
  modelId: null,
  cleanup: false,
};

const preferencesSchema = v.object({
  modelId: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  cleanup: v.boolean(),
});

type AccountKeys = { readonly serverUrl: string; readonly userId: string };

const preferencesKey = ({ serverUrl, userId }: AccountKeys): string =>
  `dictation-preferences.${keyPart(serverUrl)}.${keyPart(userId)}`;

/** What the phone kept, or the defaults when it kept nothing this build reads. */
export const readDictationPreferences = async (
  store: AccountStore,
  account: AccountKeys,
): Promise<DictationPreferences> => {
  const stored = await store.read(preferencesKey(account));
  if (stored === null) {
    return DEFAULT_DICTATION_PREFERENCES;
  }
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), preferencesSchema),
    stored,
  );
  return parsed.success ? parsed.output : DEFAULT_DICTATION_PREFERENCES;
};

export const writeDictationPreferences = async (
  store: AccountStore,
  account: AccountKeys,
  preferences: DictationPreferences,
): Promise<void> => {
  await store.write(preferencesKey(account), JSON.stringify(preferences));
};

/**
 * The model a dictation names: the one picked, while the server still
 * offers it; otherwise none, so the server's default applies.
 */
export const chosenModelId = (
  preferences: DictationPreferences,
  offered: readonly { readonly id: string }[] | null,
): string | undefined =>
  preferences.modelId !== null &&
  (offered === null || offered.some(({ id }) => id === preferences.modelId))
    ? preferences.modelId
    : undefined;

/** Deletes the ending session's dictation choices from the device. */
export const forgetDictationPreferences =
  (store: AccountStore): BeforeSessionEnd =>
  async (_reason, session) => {
    await store.remove(preferencesKey(session));
  };
