import { useEffect, useRef } from "react";

import { Result } from "better-result";
import { File } from "expo-file-system";
import { useLocale } from "use-intl";

import { applyLearnedFixes } from "@stll/transcript/corrections";
import type { LearnedFix } from "@stll/transcript/corrections";

import {
  discardRecording,
  finalText,
} from "@/components/dictation-transcription";
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
import { transcribeWithinClass } from "@/state/dictation";
import { readLearnedFixes } from "@/state/dictation-learned";
import {
  chosenModelId,
  readDictationChoice,
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
 * stella, as the composer's dictation is, with the person's model, cleanup
 * and learned fixes, and the dictation's text goes back to the keyboard. Signed out,
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
      // The audio stays on the phone only until it is transcribed.
      for (const { uri } of takeKeyboardPieces()) {
        if (uri !== undefined) {
          discardRecording(uri);
        }
      }
      return undefined;
    }
    const jobs = keyboardJobs({
      prepare: async () => await readSetup(source),
      transcribe: async (piece, setup) => await pieceText(source, piece, setup),
      finish: async (joined, setup) =>
        setup === null
          ? joined
          : await keyboardText({
              source,
              joined,
              setup,
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

/** How this person's keyboard dictations are transcribed and tidied, read once per dictation. */
type KeyboardSetup = {
  readonly preferences: DictationPreferences;
  /** The fixes learned from the person's corrections on this phone. */
  readonly learned: readonly LearnedFix[];
};

/**
 * The person's dictation choices on this phone; null when they cannot be
 * read. The default in their place could send the audio to a model of
 * another provider, region or retention than the one picked, so such a
 * dictation goes nowhere and fails. Learned fixes only tidy the text, so
 * fixes it cannot read are none.
 */
const readSetup = async (
  source: AccessTokenSource,
): Promise<KeyboardSetup | null> => {
  const session = source.session();
  const [preferences, learned] = await Promise.all([
    readDictationChoice(deviceAccountStore, session),
    session === undefined
      ? []
      : readLearnedFixes(deviceAccountStore, session).catch(() => []),
  ]);
  return preferences.isOk()
    ? { preferences: preferences.value, learned }
    : null;
};

/**
 * One piece's text, null when it could not be transcribed: with the model
 * the person picked, or only one of its provider, region side and retention
 * when the server cannot serve it (`transcribeWithinClass`), in the
 * keyboard's language. The recording is deleted once its upload has
 * settled.
 */
const pieceText = async (
  source: AccessTokenSource,
  {
    language,
    uri,
  }: { readonly language: KeyboardLanguage; readonly uri: string },
  setup: KeyboardSetup | null,
): Promise<string | null> => {
  if (setup === null) {
    discardRecording(uri);
    return null;
  }
  const { preferences } = setup;
  const transcribed = await Result.tryPromise(async () => {
    const audio = new File(uri);
    return await transcribeWithinClass({
      fetch,
      source,
      audio,
      choice: {
        modelId: chosenModelId(preferences),
        modelClass: preferences.modelClass,
        language: transcriptionLanguage(language),
      },
    });
  });
  discardRecording(uri);
  return transcribed.isOk() && transcribed.value.isOk()
    ? transcribed.value.value
    : null;
};

/**
 * The joined text, tidied by stella AI in the person's style and language
 * when they turned that on (the words as heard when cleanup fails), with
 * the fixes learned from their corrections.
 */
const keyboardText = async ({
  joined,
  locale,
  setup: { learned, preferences },
  source,
}: {
  joined: string;
  locale: string;
  setup: KeyboardSetup;
  source: AccessTokenSource;
}): Promise<string> => {
  const text = await finalText({
    source,
    cleanup: preferences.cleanup,
    style: preferences.style,
    translateTo: preferences.translateTo,
    joined,
    locale,
  });
  return applyLearnedFixes(text, learned);
};
