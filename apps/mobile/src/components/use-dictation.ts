import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { panic, Result } from "better-result";
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
import { randomUUID } from "expo-crypto";
import { useLocale } from "use-intl";

import { applyLearnedFixes } from "@stll/transcript/corrections";
import type { LearnedFix } from "@stll/transcript/corrections";
import { respell } from "@stll/transcript/spelling";

import {
  discardRecording,
  finalText,
  transcribePiece,
} from "@/components/dictation-transcription";
import { useKeptDictations } from "@/components/kept-dictations";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { deviceAccountStore } from "@/native/account-store";
import {
  releaseDictationRoute,
  routeForDictation,
  tapForDictation,
  watchDictationDevice,
} from "@/native/dictation-device";
import { DICTATION_MAX_SECONDS, readMatterVocabulary } from "@/state/dictation";
import type { Dictated } from "@/state/dictation";
import {
  DICTATION_TOTAL_MAX_MS,
  joinChunks,
  NO_PAUSE,
  watchChunk,
} from "@/state/dictation-chunks";
import type { ChunkWatch } from "@/state/dictation-chunks";
import { retriesByItself } from "@/state/dictation-kept";
import type { DictationField, PieceFailure } from "@/state/dictation-kept";
import { readLearnedFixes } from "@/state/dictation-learned";
import {
  meterShare,
  SIGNAL_UNKNOWN,
  watchSignal,
} from "@/state/dictation-level";
import type { SignalWatch } from "@/state/dictation-level";
import {
  chosenModelId,
  DEFAULT_DICTATION_PREFERENCES,
  readDictationPreferences,
} from "@/state/dictation-preferences";
import type { DictationPreferences } from "@/state/dictation-preferences";
import type {
  FinishedPiece,
  KeptDictations,
  KeptSetup,
  KeptView,
} from "@/state/kept-dictations";

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

/** What the next stop of the recorder means. */
type StopMeaning = "cut" | "finish" | "cancel";

/** What every piece of one dictation is transcribed with. */
type DictationSetup = {
  readonly source: AccessTokenSource;
  readonly preferences: DictationPreferences;
  readonly vocabulary: readonly string[];
  /** The fixes learned from the person's corrections on this phone. */
  readonly learned: readonly LearnedFix[];
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
  /** What came of each finished piece, in spoken order. */
  readonly pieces: Promise<PieceOutcome>[];
  /** How long the current piece has run, as last reported. */
  pieceMs: number;
  watch: ChunkWatch;
  /** Whether the microphone gives any signal at all, across pieces. */
  signal: SignalWatch;
};

/** What came of one piece of a dictation. */
type PieceOutcome =
  | { readonly type: "text"; readonly text: string }
  /** Not transcribed: the recording is still at `uri`. */
  | {
      readonly type: "failed";
      readonly uri: string;
      readonly error: PieceFailure;
    }
  /** The system's audio restarted and took the recording with it. */
  | { readonly type: "lost" };

/**
 * The composer's microphone. `start` asks for the microphone the first
 * time, then records; `finish` stops and sends the recording to be
 * transcribed, and the text goes to `onText`; `cancel` drops it. A long
 * dictation is recorded in pieces cut at pauses (`state/dictation-chunks`),
 * each transcribed while the next is recorded, and their texts are joined
 * in order; one that reaches the overall limit stops by itself and is
 * transcribed like a finished one. A dictation some of whose pieces could
 * not be transcribed is kept on the phone (`components/kept-dictations`)
 * and `waiting` says so until it is: its text then goes to `onText` too, or,
 * with the field closed, is offered in another `field` of its kind.
 * Otherwise every way a dictation ends gives the microphone back and
 * deletes every piece's recording, and a failure on the way shows as the
 * `failed` notice.
 */
export const useDictation = (
  onText: (dictated: Dictated) => void,
  {
    disabled = false,
    field,
    matterId,
  }: {
    /** While its field takes no text (its draft being sent), a recovered text is offered instead. */
    readonly disabled?: boolean;
    /** The kind of field the text is for, where a recovered text is offered. */
    readonly field: DictationField;
    /** The matter the text is for: its names are what the model expects. */
    readonly matterId?: string | undefined;
  },
) => {
  const { state } = useSession();
  const locale = useLocale();
  const matterTerms = useMatterTerms();
  const kept = useKeptDictations();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [notice, setNotice] = useState<DictationNotice>();
  // How long the dictation's finished pieces ran, for the clock.
  const [doneMs, setDoneMs] = useState(0);
  const [noSignal, setNoSignal] = useState(false);
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
  const press = usePressControls({
    phase,
    start: async (id) => {
      await start(id);
    },
    stop: async (how) => {
      await stop(how);
    },
    fail,
  });
  // The recorder keeps the listener of its first render; this one passes
  // each status to the handler of the latest render.
  const handleStatus = useRef<(status: RecordingStatus) => void>(
    () => undefined,
  );
  const recorder = useAudioRecorder(DICTATION_RECORDING, (status) => {
    handleStatus.current(status);
  });
  const reading = useAudioRecorderState(recorder, 250);
  const { owner, deliver, ...keptControls } = useKeptControls({
    kept,
    field,
    onText,
    disabled,
  });

  /**
   * Ends the dictation: its pieces' texts, joined, go to `onText`, or to
   * the kept dictations when a piece could not be transcribed.
   */
  const conclude = async (current: Run, how: "finish" | "cancel") => {
    run.current = null;
    const released = await Result.tryPromise(releaseMicrophone);
    if (how === "cancel") {
      discardWhenSettled(current.pieces);
      return;
    }
    setPhase("transcribing");
    const gathered = await gatherText(current);
    if (released.isErr()) {
      setNotice("failed");
    }
    settleGathered({
      gathered,
      kept,
      owner,
      setup: keptSetupOf(field, current, await current.setup),
      deliver,
      setNotice,
    });
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
      : continueRecording({ recorder, current, meaning, run, live, conclude });
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
    if (current === null) {
      return;
    }
    setNoSignal(heardNoSignal(current, latest));
    const action = stopping.current ? null : nextStop(current, latest);
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
      current: () => press.isCurrent(id),
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
    setNoSignal(false);
    run.current = newRun({
      // Read while the person speaks, so the first piece waits for nothing.
      setup: readSetup(source, preferences, async () =>
        matterId === undefined ? [] : await matterTerms(source, matterId),
      ),
      preferences,
      matterId,
      locale,
    });
    recorder.record({ forDuration: DICTATION_MAX_SECONDS });
    live.current = true;
    tapForDictation();
    setPhase("recording");
  };

  useDropOnClose(recorder, () => {
    press.moveOn();
    const dropped = run.current;
    run.current = null;
    meaning.current = "cancel";
    if (dropped !== null) {
      discardWhenSettled(dropped.pieces);
    }
  });

  return {
    phase,
    notice,
    // Between pieces the recorder still reports one `doneMs` counts.
    elapsedMs:
      phase === "recording"
        ? doneMs + (reading.isRecording ? reading.durationMillis : 0)
        : 0,
    /** How loud the microphone hears the person, 0 to 1, while recording. */
    level:
      phase === "recording" && reading.isRecording
        ? meterShare(reading.metering)
        : 0,
    /** The microphone gives no signal at all: muted, taken, or broken. */
    noSignal: phase === "recording" && noSignal,
    start: press.start,
    finish: press.finish,
    cancel: press.cancel,
    hold: press.hold,
    release: press.release,
    /** A sent message forgets the last notice and stops a start still opening the microphone. */
    settleForSend: () => {
      press.moveOn();
      setNotice(undefined);
    },
    ...keptControls,
  };
};

const newRun = ({
  setup,
  preferences,
  matterId,
  locale,
}: {
  setup: Promise<DictationSetup>;
  preferences: DictationPreferences;
  matterId: string | undefined;
  locale: string;
}): Run => ({
  setup,
  builtInMicrophone: preferences.microphone === "built-in",
  matterId,
  locale,
  doneMs: 0,
  pieces: [],
  pieceMs: 0,
  watch: NO_PAUSE,
  signal: SIGNAL_UNKNOWN,
});

/** What a dictation is kept with, should it be: as it was recorded. */
const keptSetupOf = (
  field: DictationField,
  current: Run,
  { preferences }: DictationSetup,
): KeptSetup => ({
  field,
  matterId: current.matterId ?? null,
  modelId: chosenModelId(preferences, null) ?? null,
  locale: current.locale,
  cleanup: preferences.cleanup,
});

/**
 * Where a finished dictation goes: its text to the field, or, with the
 * field closed meanwhile, to the paste offer; a dictation with a piece not
 * transcribed to the kept dictations, its recordings deleted only when the
 * phone cannot keep them.
 */
const settleGathered = ({
  gathered,
  kept,
  owner,
  setup,
  deliver,
  setNotice,
}: {
  gathered: Gathered;
  kept: KeptDictations | null;
  owner: string;
  setup: KeptSetup;
  deliver: (dictated: Dictated) => void;
  setNotice: (notice: DictationNotice) => void;
}) => {
  switch (gathered.type) {
    case "text":
      if (gathered.partly) {
        setNotice("failed");
      }
      if (kept === null) {
        deliver(gathered.dictated);
      } else {
        kept.deliver({ owner, setup, dictated: gathered.dictated });
      }
      return;
    case "nothing":
      setNotice(gathered.notice);
      return;
    case "keep": {
      const isKept =
        kept?.keep({
          owner,
          setup,
          pieces: gathered.pieces,
          refused: gathered.refused,
        }) ?? false;
      if (!isKept) {
        for (const piece of gathered.pieces) {
          if (piece.type === "audio") {
            discardRecording(piece.uri);
          }
        }
        setNotice("failed");
      }
      return;
    }
    default:
      gathered satisfies never;
      panic("A dictation ended with no known outcome");
  }
};

/** A kept dictation as a field shows it. */
export type DictationWaiting = {
  readonly status: "waiting" | "retrying" | "needs-person";
  /** Dictated into a field since closed, not this one. */
  readonly earlier: boolean;
};

const NO_KEPT: readonly KeptView[] = [];
const NO_SUBSCRIPTION = () => () => undefined;

/**
 * A field's part in the kept dictations while it is open, as `owner`: the
 * texts of those it keeps go to `onText`, as `deliver` hands them; it shows
 * its own waiting ones, else those of closed fields of its kind, with a
 * retry and a discard; and it offers the oldest text recovered from a
 * closed field of its kind.
 */
const useKeptControls = ({
  kept,
  field,
  onText,
  disabled,
}: {
  kept: KeptDictations | null;
  field: DictationField;
  onText: (dictated: Dictated) => void;
  disabled: boolean;
}) => {
  const [owner] = useState(randomUUID);
  // The latest `onText` and whether the field takes text, for a dictation
  // that ends after a render changed them.
  const deliver = useRef(onText);
  const taking = useRef(!disabled);
  useEffect(() => {
    deliver.current = onText;
    taking.current = !disabled;
  });
  useEffect(
    () =>
      kept?.own(owner, (dictated) => {
        if (taking.current) {
          deliver.current(dictated);
        }
        return taking.current;
      }),
    [kept, owner],
  );
  const views = useSyncExternalStore(
    kept?.subscribe ?? NO_SUBSCRIPTION,
    kept?.views ?? (() => NO_KEPT),
  );
  const own = views.filter(
    (view) => view.owner === owner && view.status !== "recovered",
  );
  const orphaned = views.filter(
    (view) => view.owner === null && view.field === field,
  );
  const waitingViews =
    own.length > 0
      ? own
      : orphaned.filter(({ status }) => status !== "recovered");
  const waitingIds = waitingViews.map(({ id }) => id);
  const offeredId = orphaned.find(({ status }) => status === "recovered")?.id;
  return {
    owner,
    deliver: (dictated: Dictated) => {
      deliver.current(dictated);
    },
    /**
     * A dictation of this field not transcribed yet, or one from a closed
     * field of its kind (`earlier`); undefined when there is none.
     */
    waiting: waitingOf(waitingViews, own.length === 0),
    retryWaiting: () => {
      void kept?.retry(waitingIds);
    },
    discardWaiting: () => {
      kept?.discard(waitingIds);
    },
    /** Whether a text recovered from a closed field of this kind is offered. */
    offered: offeredId !== undefined,
    /** Adds the offered text to this field, through `onText`. */
    pasteOffered: () => {
      const taken = offeredId === undefined ? undefined : kept?.take(offeredId);
      if (taken !== undefined) {
        deliver.current(taken);
      }
    },
  };
};

/** How the waiting dictations a field shows stand, the most active first. */
const waitingOf = (
  views: readonly KeptView[],
  earlier: boolean,
): DictationWaiting | undefined => {
  const statuses = new Set(views.map(({ status }) => status));
  for (const status of ["retrying", "waiting", "needs-person"] as const) {
    if (statuses.has(status)) {
      return { status, earlier };
    }
  }
  return undefined;
};

/**
 * Deletes the recordings of a dropped dictation's pieces once their
 * uploads settle; with the dictation dropped, no one is told how it went.
 */
const discardWhenSettled = (pieces: readonly Promise<PieceOutcome>[]) => {
  void (async () => {
    for (const outcome of await Promise.all(pieces)) {
      if (outcome.type === "failed") {
        discardRecording(outcome.uri);
      }
    }
  })();
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
      current.pieces.push(pieceOutcome(current.setup, url, current.matterId));
    }
  } else if (current !== null && mediaServicesDidReset === true) {
    current.pieces.push(Promise.resolve({ type: "lost" }));
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
 * Records the next piece of `current` right after a cut, unless the person
 * ended the dictation meanwhile (`meaning`, `run`) or the recorder cannot
 * go on: then it concludes, as the person meant.
 */
const continueRecording = async ({
  recorder,
  current,
  meaning,
  run,
  live,
  conclude,
}: {
  recorder: AudioRecorder;
  current: Run;
  meaning: { readonly current: StopMeaning };
  run: { readonly current: Run | null };
  live: { current: boolean };
  conclude: (current: Run, how: "finish" | "cancel") => Promise<void>;
}) => {
  const prepared = await Result.tryPromise(async () => {
    await recorder.prepareToRecordAsync();
    routeForDictation(current.builtInMicrophone);
  });
  if (
    prepared.isErr() ||
    meaning.current !== "cut" ||
    run.current !== current
  ) {
    await conclude(current, meaning.current === "cancel" ? "cancel" : "finish");
    return;
  }
  recorder.record({ forDuration: DICTATION_MAX_SECONDS });
  live.current = true;
};

/**
 * The microphone's own controls: a tap starts a dictation and the done and
 * cross buttons end it, as before; holding the microphone
 * (`HOLD_TO_TALK_MS`, `hold`) records only while it is held, and letting go
 * (`release`) finishes it, or, before recording began, calls the start off.
 * The person feels a light tap as a dictation stops, as they did when it
 * started.
 */
const usePressControls = ({
  phase,
  start,
  stop,
  fail,
}: {
  phase: DictationPhase;
  start: (id: number) => Promise<void>;
  stop: (how: StopMeaning) => Promise<void>;
  fail: () => void;
}) => {
  // Set before the first await of `start`, so a second tap while the
  // permission prompt or the recorder is still opening is ignored.
  const starting = useRef(false);
  // Which start is current: a sent message, a closed field or a microphone
  // let go moves it on, so a start still opening the microphone stops
  // before it records.
  const attempt = useRef(0);
  const held = useRef(false);
  const begin = () => {
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
  };
  const end = (how: "finish" | "cancel") => {
    tapForDictation();
    stop(how).catch(fail);
  };
  return {
    isCurrent: (id: number) => attempt.current === id,
    moveOn: () => {
      attempt.current += 1;
    },
    start: begin,
    finish: () => {
      end("finish");
    },
    cancel: () => {
      end("cancel");
    },
    hold: () => {
      held.current = phase === "idle" && !starting.current;
      begin();
    },
    release: () => {
      if (!held.current) {
        return;
      }
      held.current = false;
      if (phase === "recording") {
        end("finish");
      } else {
        // Let go while the microphone was still opening: no dictation.
        attempt.current += 1;
      }
    },
  };
};

/** How long the microphone is held before it records only while held. */
export const HOLD_TO_TALK_MS = 350;

/**
 * Whether the microphone has given no signal for long enough to say so,
 * across the dictation's pieces; keeps the watch on the run.
 */
const heardNoSignal = (
  current: Run,
  { durationMillis, metering }: Reading,
): boolean => {
  const next = watchSignal(current.signal, {
    atMs: current.doneMs + durationMillis,
    meteringDb: metering,
  });
  current.signal = next.watch;
  return next.noSignal;
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

/** What a finished dictation comes to. */
type Gathered =
  /** Its text, `partly` when the system lost a piece on the way. */
  | {
      readonly type: "text";
      readonly dictated: Dictated;
      readonly partly: boolean;
    }
  | { readonly type: "nothing"; readonly notice: "failed" | "silent" }
  /**
   * A piece could not be transcribed: the dictation is kept, and retries
   * by itself unless every such piece was `refused`.
   */
  | {
      readonly type: "keep";
      readonly pieces: readonly FinishedPiece[];
      readonly refused: boolean;
    };

/**
 * The finished dictation's text: its pieces joined in order, cleaned up
 * when the person turned that on, with the fixes learned from their
 * corrections, and the matter's names spelled as written where the model
 * came close; or nothing, when nothing was heard; or its pieces to keep,
 * when one could not be transcribed.
 */
const gatherText = async (current: Run): Promise<Gathered> => {
  const outcomes = await Promise.all(current.pieces);
  const failures = outcomes.flatMap((outcome) =>
    outcome.type === "failed" ? [outcome.error] : [],
  );
  if (failures.length > 0) {
    return {
      type: "keep",
      pieces: outcomes.flatMap((outcome): FinishedPiece[] => {
        switch (outcome.type) {
          case "text":
            return [{ type: "text", text: outcome.text }];
          case "failed":
            return [{ type: "audio", uri: outcome.uri }];
          case "lost":
            return [];
          default:
            outcome satisfies never;
            return panic("A piece came to no known outcome");
        }
      }),
      refused: !failures.some(retriesByItself),
    };
  }
  const partly = outcomes.some(({ type }) => type === "lost");
  const joined = joinChunks(
    outcomes.flatMap((outcome) =>
      outcome.type === "text" ? [outcome.text] : [],
    ),
  );
  if (joined === "") {
    return { type: "nothing", notice: partly ? "failed" : "silent" };
  }
  const setup = await current.setup;
  const text = await finalText({
    source: setup.source,
    cleanup: setup.preferences.cleanup,
    joined,
    locale: current.locale,
  });
  return {
    type: "text",
    dictated: {
      text: respell(applyLearnedFixes(text, setup.learned), setup.vocabulary),
      names: setup.vocabulary,
    },
    partly,
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
  const session = source.session();
  const [vocabulary, learned] = await Promise.all([
    terms().catch(() => []),
    // Fixes the phone cannot read are not applied; the text stays as heard.
    session === undefined
      ? []
      : readLearnedFixes(deviceAccountStore, session).catch(() => []),
  ]);
  return { source, preferences, vocabulary, learned };
};

/**
 * What came of one piece: its text, with the recording deleted, or the
 * failure, with the recording left for the dictation to be kept.
 */
const pieceOutcome = async (
  setup: Promise<DictationSetup>,
  uri: string,
  matterId: string | undefined,
): Promise<PieceOutcome> => {
  const { source, preferences, vocabulary } = await setup;
  const transcribed = await transcribePiece({
    source,
    uri,
    choice: { modelId: chosenModelId(preferences, null), matterId, vocabulary },
  });
  if (transcribed.isErr()) {
    return { type: "failed", uri, error: transcribed.error };
  }
  discardRecording(uri);
  return { type: "text", text: transcribed.value };
};
