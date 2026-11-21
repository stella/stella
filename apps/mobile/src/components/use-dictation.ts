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
  releaseDictationRoute,
  routeForDictation,
  watchDictationDevice,
} from "@/native/dictation-device";
import {
  cleanUpDictation,
  DICTATION_MAX_SECONDS,
  readMatterVocabulary,
  transcribeRecording,
} from "@/state/dictation";
import type { Dictated } from "@/state/dictation";
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

/**
 * Records alongside other apps' audio, which keeps playing, and goes on
 * when the screen locks or the person switches apps: the dictation ends
 * only when they finish it, at its limit, or when the system takes the
 * microphone.
 */
const RECORDING_MODE = {
  allowsRecording: true,
  playsInSilentMode: true,
  interruptionMode: "mixWithOthers",
  allowsBackgroundRecording: true,
} as const;

/**
 * A dictation the system ends (a call, Siri, the microphone unplugged) is
 * transcribed once this much was heard; anything shorter was no dictation.
 */
const SYSTEM_STOP_KEEPS_MS = 300;

/** Gives the microphone back, so other apps' audio resumes. */
const releaseMicrophone = async () => {
  releaseDictationRoute();
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
  /** Whether each piece records from the iPhone's own microphone. */
  readonly builtInMicrophone: boolean;
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
  onText: (dictated: Dictated) => void,
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
  // Whether a piece is open: recording, or paused by the system, which
  // still has to be stopped for its audio to count.
  const live = useRef(false);
  const run = useRef<Run | null>(null);
  const fail = () => {
    setPhase("idle");
    setNotice("failed");
  };
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
    if (gathered.dictated !== null) {
      deliver.current(gathered.dictated);
    }
  };

  const onStatus = (status: RecordingStatus) => {
    if (!status.isFinished) {
      return;
    }
    stopping.current = false;
    live.current = false;
    const how = meaning.current;
    meaning.current = "cut";
    const current = run.current;
    filePiece({ current, status, how });
    if (current === null) {
      return;
    }
    const finishedMs = current.doneMs;
    setDoneMs(finishedMs);
    const ended =
      how !== "cut" || status.hasError || finishedMs >= DICTATION_TOTAL_MAX_MS;
    const next = ended
      ? conclude(current, how === "cancel" ? "cancel" : "finish")
      : continueRecording({
          recorder,
          builtInMicrophone: current.builtInMicrophone,
          onRecording: () => {
            live.current = true;
          },
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
    if (stopping.current || !live.current) {
      return;
    }
    stopping.current = true;
    await recorder.stop();
  };

  // The system took the microphone, or the one recorded from went away: the
  // recorder is paused and would go on by itself afterwards, which is no
  // longer what the person is saying. What was heard is transcribed.
  // A stop the person already asked for stands.
  useSystemStops(() => {
    const current = run.current;
    if (current === null || meaning.current !== "cut") {
      return;
    }
    // The recorder's own count, as the last reading may be 250 ms old.
    const pieceMs = live.current ? recorder.getStatus().durationMillis : 0;
    const heardMs = current.doneMs + Math.max(current.pieceMs, pieceMs);
    stop(heardMs >= SYSTEM_STOP_KEEPS_MS ? "finish" : "cancel").catch(fail);
  });

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
    const opened = await openMicrophone({
      recorder,
      source,
      current: () => attempt.current === id,
    });
    if (opened.type !== "open") {
      if (opened.type !== "stale") {
        setNotice(opened.type);
      }
      return;
    }
    const { preferences } = opened;
    meaning.current = "cut";
    setDoneMs(0);
    run.current = {
      // Read while the person speaks, so the first piece waits for nothing.
      setup: readSetup(source, preferences, async () =>
        matterId === undefined ? [] : await matterTerms(source, matterId),
      ),
      builtInMicrophone: preferences.microphone === "built-in",
      matterId,
      locale,
      doneMs: 0,
      pieces: [],
      pieceMs: 0,
      watch: NO_PAUSE,
    };
    recorder.record({ forDuration: DICTATION_MAX_SECONDS });
    live.current = true;
    setPhase("recording");
  };

  useDropOnClose(recorder, () => {
    attempt.current += 1;
    run.current = null;
    meaning.current = "cancel";
  });

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
        .catch(fail)
        .finally(() => {
          starting.current = false;
        });
    },
    finish: () => {
      stop("finish").catch(fail);
    },
    cancel: () => {
      stop("cancel").catch(fail);
    },
    /** A sent message forgets the last notice and stops a start still opening the microphone. */
    settleForSend: () => {
      attempt.current += 1;
      setNotice(undefined);
    },
  };
};

/**
 * Files the piece the recorder just finished under the dictation: its
 * text to come, or, when the system's audio restarted and took it, its
 * loss, which the person hears of. A recording with no dictation to go to
 * is deleted.
 */
const filePiece = ({
  current,
  status: { hasError, mediaServicesDidReset, url },
  how,
}: {
  current: Run | null;
  status: RecordingStatus;
  how: StopMeaning;
}) => {
  if (url !== null) {
    if (current === null || hasError || how === "cancel") {
      discardRecording(url);
    } else {
      current.pieces.push(pieceText(current.setup, url, current.matterId));
    }
  } else if (current !== null && mediaServicesDidReset === true) {
    current.pieces.push(Promise.resolve(null));
  }
  if (current !== null) {
    current.doneMs += current.pieceMs;
    current.pieceMs = 0;
    current.watch = NO_PAUSE;
  }
};

/** How opening the microphone for a dictation went. */
type Opened =
  | { readonly type: "open"; readonly preferences: DictationPreferences }
  | { readonly type: "denied" }
  | { readonly type: "failed" }
  /** A send, a closed field or another start moved on meanwhile. */
  | { readonly type: "stale" };

/**
 * Asks for the microphone the first time, reads the person's choices,
 * which decide the microphone, and prepares the recorder on it. A start
 * that no longer counts (`current`) lets the microphone go again.
 */
const openMicrophone = async ({
  recorder,
  source,
  current,
}: {
  recorder: AudioRecorder;
  source: AccessTokenSource;
  current: () => boolean;
}): Promise<Opened> => {
  const permission = await requestRecordingPermissionsAsync();
  if (!current()) {
    return { type: "stale" };
  }
  if (!permission.granted) {
    return { type: "denied" };
  }
  const session = source.session();
  // A choice the phone cannot read is the default.
  const preferences =
    session === undefined
      ? DEFAULT_DICTATION_PREFERENCES
      : await readDictationPreferences(deviceAccountStore, session).catch(
          () => DEFAULT_DICTATION_PREFERENCES,
        );
  // A start that no longer counts leaves the shared session alone.
  if (!current()) {
    return { type: "stale" };
  }
  await setAudioModeAsync(RECORDING_MODE);
  const prepared = await Result.tryPromise(async () => {
    await recorder.prepareToRecordAsync();
    routeForDictation(preferences.microphone === "built-in");
  });
  if (prepared.isOk() && current()) {
    return { type: "open", preferences };
  }
  // No recording started, so no finished status will release it.
  await releaseMicrophone();
  return prepared.isErr() ? { type: "failed" } : { type: "stale" };
};

/**
 * Records the next piece right after a cut, unless the person ended the
 * dictation meanwhile or the recorder cannot go on: then it concludes.
 */
const continueRecording = async ({
  recorder,
  builtInMicrophone,
  onRecording,
  stillCut,
  conclude,
}: {
  recorder: AudioRecorder;
  builtInMicrophone: boolean;
  onRecording: () => void;
  stillCut: () => boolean;
  conclude: () => Promise<void>;
}) => {
  const prepared = await Result.tryPromise(async () => {
    await recorder.prepareToRecordAsync();
    routeForDictation(builtInMicrophone);
  });
  if (prepared.isErr() || !stillCut()) {
    await conclude();
    return;
  }
  recorder.record({ forDuration: DICTATION_MAX_SECONDS });
  onRecording();
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
): Promise<{
  dictated: Dictated | null;
  notice: DictationNotice | undefined;
}> => {
  const texts = await Promise.all(current.pieces);
  const heard = texts.filter((text) => text !== null);
  const failed = heard.length < texts.length;
  const joined = joinChunks(heard);
  if (joined === "") {
    return { dictated: null, notice: failed ? "failed" : "silent" };
  }
  const setup = await current.setup;
  const text = await finalText({ setup, joined, locale: current.locale });
  return {
    dictated: { text, names: setup.vocabulary },
    notice: failed ? "failed" : undefined,
  };
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

/**
 * Hands `onStop` the system's interruptions (a call, Siri) and the loss of
 * the microphone recorded from, for as long as the dictation's field is
 * open.
 */
const useSystemStops = (onStop: () => void) => {
  const handle = useEffectEvent(onStop);
  useEffect(() => {
    const subscriptions = watchDictationDevice({
      onInterruption: () => {
        handle();
      },
      onInputLost: () => {
        handle();
      },
    });
    return () => {
      for (const subscription of subscriptions) {
        subscription.remove();
      }
    };
  }, []);
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
  preferences: DictationPreferences,
  terms: () => Promise<string[]>,
): Promise<DictationSetup> => {
  const vocabulary = await terms().catch(() => []);
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
