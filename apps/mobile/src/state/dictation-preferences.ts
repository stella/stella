import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  DESKTOP_DICTATION_CLEANUP_STYLES,
  DESKTOP_DICTATION_DEFAULT_CLEANUP_STYLE,
  DESKTOP_DICTATION_TRANSLATION_LANGUAGES,
} from "@stll/api-contract/desktop-dictation-cleanup";
import type {
  DesktopDictationCleanupStyle,
  DesktopDictationTranslationLanguage,
} from "@stll/api-contract/desktop-dictation-cleanup";

import type { BeforeSessionEnd } from "@/connection/session-end";
import { modelClassSchema } from "@/state/dictation-fallback";
import type { ModelClass } from "@/state/dictation-fallback";
import type { AccountStore } from "@/state/recent-searches";
import { keyPart } from "@/state/recent-searches";

/**
 * How this account dictates on this phone: the model it picked, absent for
 * the one the server offers by default, with where that model's audio goes
 * as the list said when it was picked, whether stella AI tidies the text
 * before it lands in the box, how it writes it, the language it writes it
 * in (null keeps the spoken one) and which microphone records. Kept per
 * server and person, like recent searches, and forgotten at sign-out.
 */
export type DictationPreferences = {
  readonly modelId: string | null;
  readonly modelClass: ModelClass | null;
  readonly cleanup: boolean;
  readonly style: DesktopDictationCleanupStyle;
  readonly translateTo: DesktopDictationTranslationLanguage | null;
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
  style: DESKTOP_DICTATION_DEFAULT_CLEANUP_STYLE,
  translateTo: null,
  microphone: "built-in",
};

// The style and language came later: a choice kept before them, or one a
// newer build kept, reads with the default in their place.
const preferencesSchema = v.object({
  modelId: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  // Picked before the class was kept: unknown, so a withdrawn model falls
  // back to none.
  modelClass: v.optional(v.nullable(modelClassSchema), null),
  cleanup: v.boolean(),
  style: v.fallback(
    v.picklist(DESKTOP_DICTATION_CLEANUP_STYLES),
    DEFAULT_DICTATION_PREFERENCES.style,
  ),
  translateTo: v.fallback(
    v.nullable(v.picklist(DESKTOP_DICTATION_TRANSLATION_LANGUAGES)),
    DEFAULT_DICTATION_PREFERENCES.translateTo,
  ),
  // Kept before the microphone was a choice: the default.
  microphone: v.optional(
    v.picklist(DICTATION_MICROPHONES),
    DEFAULT_DICTATION_PREFERENCES.microphone,
  ),
});

type AccountKeys = { readonly serverUrl: string; readonly userId: string };

const preferencesKey = ({ serverUrl, userId }: AccountKeys): string =>
  `dictation-preferences.${keyPart(serverUrl)}.${keyPart(userId)}`;

/** The person's dictation choices could not be read: nothing may be uploaded on a guess. */
export class DictationPreferencesUnreadableError extends TaggedError(
  "DictationPreferencesUnreadableError",
)<{ message: string; cause?: unknown }>() {}

/**
 * The choices a dictation is transcribed with: what the phone kept, or the
 * defaults when nothing was ever kept. A dictation uploads only on these.
 * Choices the phone kept but cannot read, or no signed-in account, are an
 * error, never the defaults: the default model may be of another provider,
 * region side or retention than the one picked.
 */
export const readDictationChoice = async (
  store: AccountStore,
  account: AccountKeys | undefined,
): Promise<
  Result<DictationPreferences, DictationPreferencesUnreadableError>
> => {
  if (account === undefined) {
    return Result.err(
      new DictationPreferencesUnreadableError({
        message: "No signed-in account to read dictation choices for",
      }),
    );
  }
  const stored = await Result.tryPromise({
    try: async () => await store.read(preferencesKey(account)),
    catch: (cause) =>
      new DictationPreferencesUnreadableError({
        message: "The phone could not read the dictation choices",
        cause,
      }),
  });
  if (stored.isErr()) {
    return Result.err(stored.error);
  }
  if (stored.value === null) {
    return Result.ok(DEFAULT_DICTATION_PREFERENCES);
  }
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), preferencesSchema),
    stored.value,
  );
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        new DictationPreferencesUnreadableError({
          message: "The kept dictation choices are not readable by this build",
        }),
      );
};

/**
 * The choices as Settings shows them, the defaults when they cannot be
 * read. Only for showing and changing them; a dictation reads
 * `readDictationChoice`, which never falls back.
 */
export const readDictationPreferences = async (
  store: AccountStore,
  account: AccountKeys,
): Promise<DictationPreferences> =>
  (await readDictationChoice(store, account)).unwrapOr(
    DEFAULT_DICTATION_PREFERENCES,
  );

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
