import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { cleanUpDictation, transcribeRecording } from "@/state/dictation";
import {
  DICTATION_CHUNK_RULES,
  DICTATION_TOTAL_MAX_MS,
  joinChunks,
} from "@/state/dictation-chunks";
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

/** What a finished dictation came to. */
export type QuickDictationText =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "silent" }
  /** A piece could not be transcribed; the recording is kept for a retry. */
  | { readonly type: "failed"; readonly signedOut: boolean };

/**
 * The dictation's text: each piece transcribed with the model the person
 * picked (the server's default once it no longer offers that one), joined
 * in spoken order, and tidied by stella AI when the person turned cleanup
 * on, keeping the words as heard when cleanup fails.
 */
export const transcribeQuickDictation = async ({
  fetch,
  locale,
  pieces,
  preferences,
  source,
}: {
  readonly fetch: Fetch;
  readonly locale: string;
  readonly pieces: readonly FormPart[];
  readonly preferences: DictationPreferences;
  readonly source: AccessTokenSource;
}): Promise<QuickDictationText> => {
  const modelId = chosenModelId(preferences, null);
  const texts = await Promise.all(
    pieces.map(async (audio) => {
      const first = await transcribeRecording({
        fetch,
        source,
        audio,
        choice: { modelId },
      });
      const gone =
        first.isErr() &&
        modelId !== undefined &&
        first.error._tag === "ApiRequestError" &&
        first.error.status === 503;
      return gone ? await transcribeRecording({ fetch, source, audio }) : first;
    }),
  );
  const failure = texts.find((text) => text.isErr());
  if (failure !== undefined && failure.isErr()) {
    return {
      type: "failed",
      signedOut: failure.error._tag === "SignedOutError",
    };
  }
  const joined = joinChunks(texts.map((text) => text.unwrapOr("")));
  if (joined === "") {
    return { type: "silent" };
  }
  if (!preferences.cleanup) {
    return { type: "text", text: joined };
  }
  const cleaned = await cleanUpDictation({
    fetch,
    source,
    transcript: joined,
    locale,
  });
  return {
    type: "text",
    text: cleaned.isOk() && cleaned.value !== "" ? cleaned.value : joined,
  };
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
