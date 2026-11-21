import { applyLearnedFixes } from "@stll/transcript/corrections";
import type { LearnedFix } from "@stll/transcript/corrections";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { cleanUpDictation, transcribeWithinClass } from "@/state/dictation";
import {
  DICTATION_CHUNK_RULES,
  DICTATION_TOTAL_MAX_MS,
  joinChunks,
} from "@/state/dictation-chunks";
import { refusalOf, retriesByItself } from "@/state/dictation-kept";
import type { KeptRefusal } from "@/state/dictation-kept";
import { chosenModelId } from "@/state/dictation-preferences";
import type { DictationPreferences } from "@/state/dictation-preferences";
import type { FormPart } from "@/state/form-part";

/**
 * A dictation started outside the app, from the Action Button, Siri,
 * Shortcuts or Control Center (`modules/quick-dictation`): the native side
 * records it under a Live Activity while the app may not be running, and
 * the app transcribes it once it opens (`src/app/dictation.tsx`).
 */

/** The Live Activity's layout name (`src/widgets/dictation-activity.ios.tsx`). */
export const DICTATION_ACTIVITY_NAME = "DictationActivity";

/** What the activity's Cancel button names; the native side answers it. */
export const DICTATION_CANCEL_TARGET = "stella-dictation:cancel";

/**
 * The layout prop the native side sets to when the dictation started, on
 * both faces (`QuickDictationActivity.clockProp`).
 */
export const DICTATION_ACTIVITY_CLOCK = "startedAtMs";

/** The app route a finished dictation opens on. */
export const DICTATION_ROUTE = "dictation";

/**
 * How long a finished dictation the app never opens is kept: the audio
 * stays on the phone only until it is transcribed, or until then.
 */
export const QUICK_DICTATION_KEEP_MS = 12 * 60 * 60 * 1000;

/** What the dictation's Live Activity draws, on either face. */
export type DictationActivityProps = {
  /** Recording, or finished and waiting for the app. */
  readonly phase: "recording" | "ready";
  /** When the dictation started; the clock counts from it. */
  readonly [DICTATION_ACTIVITY_CLOCK]: number;
  readonly title: string;
  readonly detail: string;
  readonly finishLabel: string;
  readonly cancelLabel: string;
  readonly cancelTarget: string;
  /** Opens the app on the dictation, finishing a recording first. */
  readonly link: string;
};

export type QuickDictationLabels = {
  readonly recordingTitle: string;
  readonly recordingDetail: string;
  readonly readyTitle: string;
  readonly readyDetail: string;
  readonly finish: string;
  readonly cancel: string;
};

/**
 * What the native side keeps while someone is signed in, so a press can
 * record while the app's JavaScript is not running: the activity's two
 * faces (their clock set natively), the Cancel target and the same rules
 * the composer's microphone cuts pieces by.
 */
export const quickDictationConfiguration = ({
  labels,
  link,
}: {
  labels: QuickDictationLabels;
  link: string;
}) => {
  const face = {
    [DICTATION_ACTIVITY_CLOCK]: 0,
    finishLabel: labels.finish,
    cancelLabel: labels.cancel,
    cancelTarget: DICTATION_CANCEL_TARGET,
    link,
  } as const;
  return {
    activityName: DICTATION_ACTIVITY_NAME,
    cancelTarget: DICTATION_CANCEL_TARGET,
    recording: {
      ...face,
      phase: "recording",
      title: labels.recordingTitle,
      detail: labels.recordingDetail,
    } satisfies DictationActivityProps,
    ready: {
      ...face,
      phase: "ready",
      title: labels.readyTitle,
      detail: labels.readyDetail,
    } satisfies DictationActivityProps,
    rules: {
      ...DICTATION_CHUNK_RULES,
      totalMaxMs: DICTATION_TOTAL_MAX_MS,
      keepMs: QUICK_DICTATION_KEEP_MS,
    },
  };
};

/** One piece of a finished dictation: its text, or, not transcribed, its place among the recordings. */
export type QuickPiece =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "audio"; readonly index: number };

/** What a finished dictation came to. */
export type QuickDictationText =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "silent" }
  /**
   * A piece could not be transcribed: the pieces in spoken order, to keep
   * with the composer's dictations (`state/kept-dictations`), which retry
   * by themselves unless every failure was `refused`.
   */
  | {
      readonly type: "failed";
      readonly signedOut: boolean;
      readonly pieces: readonly QuickPiece[];
      readonly refused: boolean;
      readonly refusedFor: KeptRefusal | null;
    };

/**
 * The dictation's text: each piece transcribed with the model the person
 * picked, or only one of its provider, region side and retention when the
 * server cannot serve it (`transcribeWithinClass`), joined in spoken order,
 * tidied by stella AI when the person turned cleanup on (the words as heard
 * when cleanup fails), with the fixes learned from their corrections.
 */
export const transcribeQuickDictation = async ({
  fetch,
  learned,
  locale,
  pieces,
  preferences,
  source,
}: {
  readonly fetch: Fetch;
  readonly learned: readonly LearnedFix[];
  readonly locale: string;
  readonly pieces: readonly FormPart[];
  readonly preferences: DictationPreferences;
  readonly source: AccessTokenSource;
}): Promise<QuickDictationText> => {
  const choice = {
    modelId: chosenModelId(preferences),
    modelClass: preferences.modelClass,
  };
  const texts = await Promise.all(
    pieces.map(
      async (audio) =>
        await transcribeWithinClass({ fetch, source, audio, choice }),
    ),
  );
  const failures = texts.flatMap((text) => (text.isErr() ? [text.error] : []));
  if (failures.length > 0) {
    const refused = !failures.some(retriesByItself);
    return {
      type: "failed",
      signedOut: failures.some(({ _tag }) => _tag === "SignedOutError"),
      pieces: texts.map((text, index): QuickPiece =>
        text.isOk()
          ? { type: "text", text: text.value }
          : { type: "audio", index },
      ),
      refused,
      refusedFor:
        refused && failures.some((failure) => refusalOf(failure) === "model")
          ? "model"
          : null,
    };
  }
  const joined = joinChunks(texts.map((text) => text.unwrapOr("")));
  if (joined === "") {
    return { type: "silent" };
  }
  const cleaned = preferences.cleanup
    ? await cleanUpDictation({ fetch, source, transcript: joined, locale })
    : null;
  const text =
    cleaned?.isOk() === true && cleaned.value !== "" ? cleaned.value : joined;
  return { type: "text", text: applyLearnedFixes(text, learned) };
};

/** The document a dictation saved to a matter becomes: plain text, named for when it was spoken. */
export const dictationDocument = ({
  text,
  title,
}: {
  text: string;
  title: string;
}) => ({
  name: `${title}.txt`,
  mimeType: "text/plain",
  contents: text.endsWith("\n") ? text : `${text}\n`,
});
