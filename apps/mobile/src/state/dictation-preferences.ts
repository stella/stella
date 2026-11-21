import * as v from "valibot";

import type { BeforeSessionEnd } from "@/connection/session-end";
import type { AccountStore } from "@/state/recent-searches";
import { keyPart } from "@/state/recent-searches";

/**
 * How this account dictates on this phone: the model it picked, absent for
 * the one the server offers by default, whether stella AI tidies the text
 * before it lands in the box, and which microphone records. Kept per server
 * and person, like recent searches, and forgotten at sign-out.
 */
export type DictationPreferences = {
  readonly modelId: string | null;
  readonly cleanup: boolean;
  readonly microphone: DictationMicrophone;
};

/**
 * Which microphone a dictation records from: the iPhone's own, so AirPods
 * or a car keep playing in full quality instead of switching to call audio,
 * or whichever the system routes to, a headset's included.
 */
const DICTATION_MICROPHONES = ["built-in", "system"] as const;

export type DictationMicrophone = (typeof DICTATION_MICROPHONES)[number];

export const DEFAULT_DICTATION_PREFERENCES: DictationPreferences = {
  modelId: null,
  cleanup: false,
  microphone: "built-in",
};

const preferencesSchema = v.object({
  modelId: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  cleanup: v.boolean(),
  // Kept before the microphone was a choice: the default.
  microphone: v.optional(
    v.picklist(DICTATION_MICROPHONES),
    DEFAULT_DICTATION_PREFERENCES.microphone,
  ),
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

/**
 * The model Settings shows as picked: the one a dictation names. `offered`
 * is the server's list, null when it could not be read; the picked model is
 * then still sent with every dictation, so it stays shown as picked, and
 * `unlisted` says the list has no row for it.
 */
export const shownModel = (
  preferences: DictationPreferences,
  offered: readonly { readonly id: string }[] | null,
): { readonly selected: string | null; readonly unlisted: boolean } => {
  const selected = chosenModelId(preferences, offered) ?? null;
  return {
    selected,
    unlisted:
      selected !== null && !(offered ?? []).some(({ id }) => id === selected),
  };
};

/** Deletes the ending session's dictation choices from the device. */
export const forgetDictationPreferences =
  (store: AccountStore): BeforeSessionEnd =>
  async (_reason, session) => {
    await store.remove(preferencesKey(session));
  };
