import { useEffect, useRef } from "react";

import { Result } from "better-result";
import { File } from "expo-file-system";
import { useLocale } from "use-intl";

import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { deviceAccountStore } from "@/native/account-store";
import {
  deliverKeyboardOutcome,
  endKeyboardSession,
  keyboardDictationAvailable,
  onKeyboardDictation,
  takeKeyboardPieces,
} from "@/native/keyboard-dictation";
import { cleanUpDictation, transcribeRecording } from "@/state/dictation";
import {
  chosenModelId,
  DEFAULT_DICTATION_PREFERENCES,
  readDictationPreferences,
} from "@/state/dictation-preferences";
import type { DictationPreferences } from "@/state/dictation-preferences";
import {
  keyboardJobs,
  transcriptionLanguage,
} from "@/state/keyboard-dictation";
import type { KeyboardLanguage } from "@/state/keyboard-dictation";

/**
 * Transcribes what the stella keyboard records. The native session records
 * in pieces and hands each over as it ends; each is transcribed through
 * stella, as the composer's dictation is, with the person's model and
 * cleanup, and the dictation's text goes back to the keyboard. Signed out,
 * the session closes and what it recorded is deleted unheard.
 */
export const KeyboardDictationHost = () => {
  const { state } = useSession();
  const locale = useLocale();
  // The latest language for cleanup, without starting the jobs over: a
  // dictation under way keeps its pieces.
  const cleanupLocale = useRef(locale);
  useEffect(() => {
    cleanupLocale.current = locale;
  });
  const source = state.status === "signed-in" ? state.source : null;

  useEffect(() => {
    if (!keyboardDictationAvailable()) {
      return undefined;
    }
    if (source === null) {
      endKeyboardSession();
      for (const { uri } of takeKeyboardPieces()) {
        discard(uri);
      }
      return undefined;
    }
    const jobs = keyboardJobs({
      prepare: async () => await readPreferences(source),
      transcribe: async (piece, preferences) =>
        await pieceText(source, piece, preferences),
      finish: async (joined, preferences) =>
        await finalText({
          source,
          joined,
          preferences,
          locale: cleanupLocale.current,
        }),
      deliver: (jobId, outcome) => {
        deliverKeyboardOutcome(jobId, outcome);
      },
    });
    const drain = () => {
      // `take` delivers every outcome itself and never rejects.
      void jobs.take(takeKeyboardPieces());
    };
    const stop = onKeyboardDictation("onCapture", drain);
    drain();
    return stop;
  }, [source]);

  return null;
};

/** Deletes a piece's recording; the audio stays on the phone only until it is transcribed. */
const discard = (uri: string | undefined) => {
  if (uri === undefined) {
    return;
  }
  Result.try(() => {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  });
};

/** The person's dictation choices on this phone; a choice it cannot read is the default. */
const readPreferences = async (
  source: AccessTokenSource,
): Promise<DictationPreferences> => {
  const session = source.session();
  return session === undefined
    ? DEFAULT_DICTATION_PREFERENCES
    : await readDictationPreferences(deviceAccountStore, session).catch(
        () => DEFAULT_DICTATION_PREFERENCES,
      );
};

/**
 * One piece's text, null when it could not be transcribed: with the model
 * the person picked, or the server's default when the server no longer
 * offers it, in the keyboard's language. The recording is deleted once its
 * upload has settled.
 */
const pieceText = async (
  source: AccessTokenSource,
  {
    language,
    uri,
  }: { readonly language: KeyboardLanguage; readonly uri: string },
  preferences: DictationPreferences,
): Promise<string | null> => {
  const transcribed = await Result.tryPromise(async () => {
    const audio = new File(uri);
    const choice = {
      modelId: chosenModelId(preferences, null),
      language: transcriptionLanguage(language),
    };
    const first = await transcribeRecording({ fetch, source, audio, choice });
    const retry =
      first.isErr() &&
      choice.modelId !== undefined &&
      first.error._tag === "ApiRequestError" &&
      first.error.status === 503;
    return retry
      ? await transcribeRecording({
          fetch,
          source,
          audio,
          choice: { ...choice, modelId: undefined },
        })
      : first;
  });
  discard(uri);
  return transcribed.isOk() && transcribed.value.isOk()
    ? transcribed.value.value
    : null;
};

/** The joined text, tidied by stella AI when the person turned that on. */
const finalText = async ({
  joined,
  locale,
  preferences,
  source,
}: {
  joined: string;
  locale: string;
  preferences: DictationPreferences;
  source: AccessTokenSource;
}): Promise<string> => {
  if (!preferences.cleanup) {
    return joined;
  }
  const cleaned = await cleanUpDictation({
    fetch,
    source,
    transcript: joined,
    locale,
  });
  return cleaned.isOk() ? cleaned.value : joined;
};
