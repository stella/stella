import { Result } from "better-result";
import { File } from "expo-file-system";

import type { AccessTokenSource } from "@/connection/session";
import {
  cleanUpDictation,
  readDictationModels,
  transcribeRecording,
} from "@/state/dictation";
import { sameClassFallback } from "@/state/dictation-fallback";
import type { ModelClass } from "@/state/dictation-fallback";
import { RecordingReadError } from "@/state/dictation-kept";
import type { PieceFailure } from "@/state/dictation-kept";

/** What a recording is transcribed with: the model, the matter and its names. */
type PieceChoice = {
  readonly modelId: string | undefined;
  /** Where the picked model's audio goes, as kept when it was picked. */
  readonly modelClass: ModelClass | null;
  readonly matterId: string | undefined;
  readonly vocabulary: readonly string[];
};

/**
 * One recording's text, with the model the person picked. When the server
 * cannot serve it (503), the recording goes once more only to a model of
 * the same provider, region side and retention (`sameClassFallback`);
 * with none, it goes nowhere else and the failure stands, so the dictation
 * is kept and a retry uses the picked model. The recording stays where it
 * is: the caller deletes it once it no longer needs it.
 */
export const transcribePiece = async ({
  source,
  uri,
  choice,
}: {
  readonly source: AccessTokenSource;
  readonly uri: string;
  readonly choice: PieceChoice;
}): Promise<Result<string, PieceFailure>> => {
  const opened = Result.try({
    try: () => new File(uri),
    catch: (cause) =>
      new RecordingReadError({
        message: `The recording at ${uri} could not be opened`,
        cause,
      }),
  });
  if (opened.isErr()) {
    return Result.err(opened.error);
  }
  const audio = opened.value;
  // A missing recording would fail only as the upload reads it, which reads
  // as the network failing and would be retried by itself.
  if (!audio.exists) {
    return Result.err(
      new RecordingReadError({ message: `No recording at ${uri}` }),
    );
  }
  const first = await transcribeRecording({ fetch, source, audio, choice });
  const picked = choice.modelId;
  if (
    picked === undefined ||
    !first.isErr() ||
    first.error._tag !== "ApiRequestError" ||
    first.error.status !== 503
  ) {
    return first;
  }
  const offered = await readDictationModels({ fetch, source });
  const fallback = offered.isOk()
    ? sameClassFallback(picked, choice.modelClass, offered.value)
    : undefined;
  return fallback === undefined
    ? first
    : await transcribeRecording({
        fetch,
        source,
        audio,
        choice: { ...choice, modelId: fallback },
      });
};

/** The joined text, tidied by stella AI when the person turned that on; the words as heard when cleanup fails. */
export const finalText = async ({
  source,
  cleanup,
  joined,
  locale,
}: {
  readonly source: AccessTokenSource;
  readonly cleanup: boolean;
  readonly joined: string;
  readonly locale: string;
}): Promise<string> => {
  if (!cleanup) {
    return joined;
  }
  const cleaned = await cleanUpDictation({
    fetch,
    source,
    transcript: joined,
    locale,
  });
  return cleaned.isOk() && cleaned.value !== "" ? cleaned.value : joined;
};

/**
 * Removes a recording once nothing reads it any more. Whether it is gone.
 */
export const discardRecording = (uri: string): boolean =>
  Result.try(() => {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  }).isOk();
