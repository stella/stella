import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Result } from "better-result";
import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import type {
  AudioRecorder,
  RecorderState,
  RecordingOptions,
  RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { useLocale } from "use-intl";

import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { deviceAccountStore } from "@/native/account-store";
import {
  cleanUpDictation,
  DICTATION_MAX_SECONDS,
  readMatterVocabulary,
  transcribeRecording,
} from "@/state/dictation";
import {
  DICTATION_TOTAL_MAX_MS,
  joinChunks,
  NO_PAUSE,
  watchChunk,
} from "@/state/dictation-chunks";
import type { ChunkWatch } from "@/state/dictation-chunks";
import {
  chosenModelId,
  DEFAULT_DICTATION_PREFERENCES,
  readDictationPreferences,
} from "@/state/dictation-preferences";
import type { DictationPreferences } from "@/state/dictation-preferences";

/**
 * Speech for transcription, not music: one channel at 16 kHz, which is what
 * the transcription models listen at, keeps a minute of AAC well under a
 * megabyte. The level is metered, so a long dictation is cut at a pause.
 */
const DICTATION_RECORDING: RecordingOptions = {
  extension: ".m4a",
  isMeteringEnabled: true,
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 32_000,
  android: { outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: "audio/mp4", bitsPerSecond: 32_000 },
};

export type DictationPhase = "idle" | "recording" | "transcribing";

/** Why a dictation gave no text. */
export type DictationNotice = "denied" | "failed" | "silent";

/** Gives the microphone back, so other apps' audio resumes. */
const releaseMicrophone = async () => {
  await setAudioModeAsync({ allowsRecording: false });
};

/**
 * Removes a recording once nothing reads it any more: the audio of a
 * dictation stays on the phone only while it is being transcribed. Whether
 * it is gone.
 */
const discardRecording = (uri: string): boolean =>
  Result.try(() => {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  }).isOk();

/** What the next stop of the recorder means. */
type StopMeaning = "cut" | "finish" | "cancel";

/** What every piece of one dictation is transcribed with. */
type DictationSetup = {
  readonly source: AccessTokenSource;
  readonly preferences: DictationPreferences;
  readonly vocabulary: readonly string[];
};

/**
 * The dictation under way. The recorder keeps the status listener of its
 * first render, so what that listener needs lives here, not in a closure.
 */
type Run = {
  readonly setup: Promise<DictationSetup>;
  readonly matterId: string | undefined;
  readonly locale: string;
  /** How long the finished pieces ran. */
  doneMs: number;
  /** Each finished piece's text, null when it failed, in spoken order. */
  readonly pieces: Promise<string | null>[];
  /** How long the current piece has run, as last reported. */
  pieceMs: number;
  watch: ChunkWatch;
};

/**
 * The composer's microphone. `start` asks for the microphone the first
 * time, then records; `finish` stops and sends the recording to be
 * transcribed, and the text goes to `onText`; `cancel` drops it. A long
 * dictation is recorded in pieces cut at pauses (`state/dictation-chunks`),
 * each transcribed while the next is recorded, and their texts are joined
 * in order; one that reaches the overall limit stops by itself and is
 * transcribed like a finished one. Every way a dictation ends gives the
 * microphone back and deletes every piece's recording, and a failure on the
 * way shows as the `failed` notice.
 */
export const useDictation = (
  onText: (text: string) => void,
  {
    matterId,
  }: {
    /** The matter the text is for: its names are what the model expects. */
    readonly matterId?: string | undefined;
  } = {},
) => {
  const { state } = useSession();
  const locale = useLocale();
  const matterTerms = useMatterTerms();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [notice, setNotice] = useState<DictationNotice>();
  // How long the dictation's finished pieces ran, for the clock.
  const [doneMs, setDoneMs] = useState(0);
  // A stop the recorder makes by itself, at a piece's limit, is a cut.
  const meaning = useRef<StopMeaning>("cut");
  const stopping = useRef(false);
  const run = useRef<Run | null>(null);
  // Set before the first await of `start`, so a second tap while the
  // permission prompt or the recorder is still opening is ignored.
  const starting = useRef(false);
  // Which start is current: a sent message or a closed composer moves it on,
  // so a start still opening the microphone stops before it records.
  const attempt = useRef(0);
  // The recorder keeps the listener of its first render; this one passes
  // each status to the handler of the latest render.
  const handleStatus = useRef<(status: RecordingStatus) => void>(
    () => undefined,
  );
  const recorder = useAudioRecorder(DICTATION_RECORDING, (status) => {
    handleStatus.current(status);
  });
  const reading = useAudioRecorderState(recorder, 250);
  // The latest `onText`, for a dictation that ends after a render changed it.
  const deliver = useRef(onText);
  useEffect(() => {
    deliver.current = onText;
  });

  /** Ends the dictation: its pieces' texts, joined, go to `onText`. */
  const conclude = async (current: Run, how: "finish" | "cancel") => {
    run.current = null;
    const released = await Result.tryPromise(releaseMicrophone);
    if (how === "cancel") {
      return;
    }
    setPhase("transcribing");
    const gathered = await gatherText(current);
    if (released.isErr() || gathered.notice !== undefined) {
      setNotice(gathered.notice ?? "failed");
    }
    if (gathered.text !== null) {
      deliver.current(gathered.text);
    }
  };

  const onStatus = (status: RecordingStatus) => {
    if (!status.isFinished) {
      return;
    }
    stopping.current = false;
    const how = meaning.current;
    meaning.current = "cut";
    const current = run.current;
    const { url } = status;
    if (url !== null) {
      if (current === null || status.hasError || how === "cancel") {
        discardRecording(url);
      } else {
        current.pieces.push(pieceText(current.setup, url, current.matterId));
      }
    }
    if (current === null) {
      return;
    }
    const finishedMs = current.doneMs + current.pieceMs;
    current.doneMs = finishedMs;
    setDoneMs(finishedMs);
    current.pieceMs = 0;
    current.watch = NO_PAUSE;
    const ended =
      how !== "cut" || status.hasError || finishedMs >= DICTATION_TOTAL_MAX_MS;
    const next = ended
      ? conclude(current, how === "cancel" ? "cancel" : "finish")
      : continueRecording({
          recorder,
          stillCut: () => meaning.current === "cut" && run.current === current,
          conclude: async () => {
            await conclude(
              current,
              meaning.current === "cancel" ? "cancel" : "finish",
            );
          },
        });
    next
      .catch(() => {
        setNotice("failed");
      })
      .finally(() => {
        if (run.current === null) {
          setPhase("idle");
        }
      });
  };

  useEffect(() => {
    handleStatus.current = onStatus;
  });

  const stop = async (how: StopMeaning) => {
    meaning.current = how;
    // Between pieces nothing records: the next piece reads the meaning
    // before it starts.
    if (stopping.current || !recorder.isRecording) {
      return;
    }
    stopping.current = true;
    await recorder.stop();
  };

  useCutAtPauses(reading, (latest) => {
    const current = run.current;
    const action =
      current === null || stopping.current ? null : nextStop(current, latest);
    if (action !== null) {
      void stop(action).catch(() => undefined);
    }
  });

  const start = async (id: number) => {
    setNotice(undefined);
    if (state.status !== "signed-in") {
      return;
    }
    const { source } = state;
    const permission = await requestRecordingPermissionsAsync();
    if (attempt.current !== id) {
      return;
    }
    if (!permission.granted) {
      setNotice("denied");
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    const prepared = await Result.tryPromise(
      async () => await recorder.prepareToRecordAsync(),
    );
    if (prepared.isErr() || attempt.current !== id) {
      // No recording started, so no finished status will release it.
      if (prepared.isErr()) {
        setNotice("failed");
      }
      await releaseMicrophone();
      return;
    }
    meaning.current = "cut";
    setDoneMs(0);
    run.current = {
      // Read while the person speaks, so the first piece waits for nothing.
      setup: readSetup(source, async () =>
        matterId === undefined ? [] : await matterTerms(source, matterId),
      ),
      matterId,
      locale,
      doneMs: 0,
      pieces: [],
      pieceMs: 0,
      watch: NO_PAUSE,
    };
    recorder.record({ forDuration: DICTATION_MAX_SECONDS });
    setPhase("recording");
  };

  useDropOnClose(recorder, () => {
    attempt.current += 1;
    run.current = null;
    meaning.current = "cancel";
  });

  const ended = () => {
    setPhase("idle");
    setNotice("failed");
  };

  return {
    phase,
    notice,
    // Between pieces the recorder still reports one `doneMs` counts.
    elapsedMs:
      phase === "recording"
        ? doneMs + (reading.isRecording ? reading.durationMillis : 0)
        : 0,
    start: () => {
      if (starting.current || phase !== "idle") {
        return;
      }
      starting.current = true;
      attempt.current += 1;
      start(attempt.current)
        .catch(ended)
        .finally(() => {
          starting.current = false;
        });
    },
    finish: () => {
      stop("finish").catch(ended);
    },
    cancel: () => {
      stop("cancel").catch(ended);
    },
    /** A sent message forgets the last notice and stops a start still opening the microphone. */
    settleForSend: () => {
      attempt.current += 1;
      setNotice(undefined);
    },
  };
};

/**
 * Records the next piece right after a cut, unless the person ended the
 * dictation meanwhile or the recorder cannot go on: then it concludes.
 */
const continueRecording = async ({
  recorder,
  stillCut,
  conclude,
}: {
  recorder: AudioRecorder;
  stillCut: () => boolean;
  conclude: () => Promise<void>;
}) => {
  const prepared = await Result.tryPromise(
    async () => await recorder.prepareToRecordAsync(),
  );
  if (prepared.isErr() || !stillCut()) {
    await conclude();
    return;
  }
  recorder.record({ forDuration: DICTATION_MAX_SECONDS });
};

/** One reading of the recorder while it records. */
type Reading = {
  readonly durationMillis: number;
  readonly metering: number | undefined;
};

/**
 * What a reading means for the dictation: stop it whole at its own limit,
 * cut the piece at a pause or its limit, or nothing. Keeps the piece's
 * length and pause watch on the run for the next reading and the stop.
 */
const nextStop = (current: Run, { durationMillis, metering }: Reading) => {
  current.pieceMs = durationMillis;
  if (current.doneMs + durationMillis >= DICTATION_TOTAL_MAX_MS) {
    return "finish";
  }
  const next = watchChunk(current.watch, {
    pieceMs: durationMillis,
    meteringDb: metering,
  });
  current.watch = next.watch;
  return next.cut ? "cut" : null;
};

/**
 * The finished dictation's text: its pieces joined in order and cleaned up
 * when the person turned that on, or null when nothing was heard. A piece
 * that failed leaves a gap the person should know about.
 */
const gatherText = async (
  current: Run,
): Promise<{ text: string | null; notice: DictationNotice | undefined }> => {
  const texts = await Promise.all(current.pieces);
  const heard = texts.filter((text) => text !== null);
  const failed = heard.length < texts.length;
  const joined = joinChunks(heard);
  if (joined === "") {
    return { text: null, notice: failed ? "failed" : "silent" };
  }
  const text = await finalText({
    setup: await current.setup,
    joined,
    locale: current.locale,
  });
  return { text, notice: failed ? "failed" : undefined };
};

/**
 * Hands each reading of the recorder while it records to `onReading`, which
 * cuts the piece at a pause or its limit and stops the whole dictation at
 * its own.
 */
const useCutAtPauses = (
  { durationMillis, isRecording, metering }: RecorderState,
  onReading: (reading: Reading) => void,
) => {
  // A new reading, not a new render, is what calls it.
  const read = useEffectEvent(onReading);
  useEffect(() => {
    if (isRecording) {
      read({ durationMillis, metering });
    }
  }, [durationMillis, isRecording, metering]);
};

/** One matter's names for the model, read once per matter while the composer is open; none when they cannot be read. */
const useMatterTerms = () => {
  const cached = useRef<{ matterId: string; terms: string[] }>(undefined);
  return async (source: AccessTokenSource, id: string): Promise<string[]> => {
    if (cached.current?.matterId === id) {
      return cached.current.terms;
    }
    const read = await readMatterVocabulary({ fetch, source, matterId: id });
    const terms = read.unwrapOr([]);
    if (read.isOk()) {
      cached.current = { matterId: id, terms };
    }
    return terms;
  };
};

/**
 * A composer that closes mid-dictation, as on leaving the thread, drops the
 * recording: the recorder's own release reports no finished status, so the
 * microphone and the file are let go here, and no next piece starts. With
 * the composer gone, a failure here has nowhere to show; each step still
 * runs after the one before it fails.
 */
const useDropOnClose = (recorder: AudioRecorder, onClose: () => void) => {
  // Only a new recorder, or the composer closing, lets go.
  const close = useEffectEvent(onClose);
  useEffect(
    () => () => {
      close();
      if (!recorder.isRecording) {
        return;
      }
      const { uri } = recorder;
      // Whether the closing cleaned up fully; with no one to tell, each step
      // runs whatever the one before it did.
      void (async () => {
        const stopped = await Result.tryPromise(
          async () => await recorder.stop(),
        );
        const released = await Result.tryPromise(releaseMicrophone);
        const removed = uri === null || discardRecording(uri);
        return stopped.isOk() && released.isOk() && removed;
      })();
    },
    [recorder],
  );
};

/** The person's choices on this phone and the matter's names, read once per dictation. */
const readSetup = async (
  source: AccessTokenSource,
  terms: () => Promise<string[]>,
): Promise<DictationSetup> => {
  const session = source.session();
  // A choice the phone cannot read is no choice: the server's default.
  const [preferences, vocabulary] = await Promise.all([
    session === undefined
      ? DEFAULT_DICTATION_PREFERENCES
      : readDictationPreferences(deviceAccountStore, session).catch(
          () => DEFAULT_DICTATION_PREFERENCES,
        ),
    terms().catch(() => []),
  ]);
  return { source, preferences, vocabulary };
};

/**
 * One piece's text, null when it could not be transcribed: with the model
 * the person picked, or the server's default when the server no longer
 * offers it. The recording is deleted once its upload has settled.
 */
const pieceText = async (
  setup: Promise<DictationSetup>,
  url: string,
  matterId: string | undefined,
): Promise<string | null> => {
  const transcribed = await Result.tryPromise(async () => {
    const { source, preferences, vocabulary } = await setup;
    const audio = new File(url);
    const choice = {
      modelId: chosenModelId(preferences, null),
      matterId,
      vocabulary,
    };
    const first = await transcribeRecording({ fetch, source, audio, choice });
    // A model the server no longer offers: the recording still counts, with
    // the model the server offers by default.
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
  discardRecording(url);
  return transcribed.isOk() && transcribed.value.isOk()
    ? transcribed.value.value
    : null;
};

/** The joined text, tidied by stella AI when the person turned that on; the words as heard when cleanup fails. */
const finalText = async ({
  setup,
  joined,
  locale,
}: {
  setup: DictationSetup;
  joined: string;
  locale: string;
}): Promise<string> => {
  if (!setup.preferences.cleanup) {
    return joined;
  }
  const cleaned = await cleanUpDictation({
    fetch,
    source: setup.source,
    transcript: joined,
    locale,
  });
  return cleaned.isOk() && cleaned.value !== "" ? cleaned.value : joined;
};
