import * as v from "valibot";

import type { BeforeSessionEnd } from "@/connection/session-end";
import { modelClassSchema } from "@/state/dictation-fallback";
import type { ModelClass } from "@/state/dictation-fallback";
import type { AccountStore } from "@/state/recent-searches";
import { keyPart } from "@/state/recent-searches";

/**
 * How this account dictates on this phone: the model it picked, absent for
 * the one the server offers by default, with where that model's audio goes
 * as the list said when it was picked, whether stella AI tidies the text
 * before it lands in the box, and which microphone records. Kept per server
 * and person, like recent searches, and forgotten at sign-out.
 */
export type DictationPreferences = {
  readonly modelId: string | null;
  readonly modelClass: ModelClass | null;
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
  modelClass: null,
  cleanup: false,
  microphone: "built-in",
};

const preferencesSchema = v.object({
  modelId: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  // Picked before the class was kept: unknown, so a withdrawn model falls
  // back to none.
  modelClass: v.optional(v.nullable(modelClassSchema), null),
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
 * The model a dictation names: the one picked, absent for the server's
 * default. A picked model the server stopped offering stays named until the
 * person picks another: the server then refuses it, and only a model of its
 * class may take the recording (`state/dictation-fallback`).
 */
export const chosenModelId = (
  preferences: DictationPreferences,
): string | undefined => preferences.modelId ?? undefined;

/**
 * Where the picked model stands in the server's list (`offered`, null when
 * it could not be read): listed; `unread`, the list unknown; or
 * `withdrawn`, no longer offered.
 */
export type ModelStanding = "listed" | "unread" | "withdrawn";

/**
 * The model Settings shows as picked, the one a dictation names, and
 * whether the list has its row.
 */
export const shownModel = (
  preferences: DictationPreferences,
  offered: readonly { readonly id: string }[] | null,
): { readonly selected: string | null; readonly standing: ModelStanding } => {
  const selected = preferences.modelId;
  if (selected === null) {
    return { selected, standing: "listed" };
  }
  if (offered === null) {
    return { selected, standing: "unread" };
  }
  return {
    selected,
    standing: offered.some(({ id }) => id === selected)
      ? "listed"
      : "withdrawn",
  };
};

/** Deletes the ending session's dictation choices from the device. */
export const forgetDictationPreferences =
  (store: AccountStore): BeforeSessionEnd =>
  async (_reason, session) => {
    await store.remove(preferencesKey(session));
  };
