import { useRef, useState } from "react";

import { Result } from "better-result";
import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import type { RecordingOptions, RecordingStatus } from "expo-audio";
import { File } from "expo-file-system";

import { useSession } from "@/connection/session-provider";
import { DICTATION_MAX_SECONDS, transcribeRecording } from "@/state/dictation";

/**
 * Speech for transcription, not music: one channel at 16 kHz, which is what
 * the transcription models listen at, keeps a minute of AAC well under a
 * megabyte.
 */
const DICTATION_RECORDING: RecordingOptions = {
  extension: ".m4a",
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

/**
 * The composer's microphone. `start` asks for the microphone the first
 * time, then records; `finish` stops and sends the recording to be
 * transcribed, and the text goes to `onText`; `cancel` drops it. A
 * recording that reaches the transcription's limit of a minute stops by
 * itself and is transcribed like a finished one. Every way a dictation
 * ends gives the microphone back and deletes the recording, and a failure
 * on the way shows as the `failed` notice.
 */
export const useDictation = (onText: (text: string) => void) => {
  const { state } = useSession();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [notice, setNotice] = useState<DictationNotice>();
  // What a stop means, read when the recorder reports it: a recording that
  // stops by itself at the limit is kept.
  const keep = useRef(true);
  // Set before the first await of `start`, so a second tap while the
  // permission prompt or the recorder is still opening is ignored.
  const starting = useRef(false);

  const transcribe = async (uri: string) => {
    if (state.status !== "signed-in") {
      return;
    }
    setPhase("transcribing");
    const result = await transcribeRecording({
      fetch,
      source: state.source,
      uri,
    });
    if (result.isErr()) {
      setNotice("failed");
      return;
    }
    if (result.value === "") {
      setNotice("silent");
      return;
    }
    onText(result.value);
  };

  const settle = async (status: RecordingStatus) => {
    const released = await Result.tryPromise(releaseMicrophone);
    const usable = !status.hasError && released.isOk();
    if (!usable) {
      setNotice("failed");
    }
    const { url } = status;
    if (url === null) {
      return;
    }
    const transcribed =
      usable && keep.current
        ? await Result.tryPromise(async () => await transcribe(url))
        : Result.ok();
    // The upload reads the file, so it is deleted only once it has settled.
    if (!discardRecording(url) || transcribed.isErr()) {
      setNotice("failed");
    }
  };

  const onStatus = (status: RecordingStatus) => {
    if (!status.isFinished) {
      return;
    }
    settle(status)
      .catch(() => {
        setNotice("failed");
      })
      .finally(() => {
        setPhase("idle");
      });
  };

  const recorder = useAudioRecorder(DICTATION_RECORDING, onStatus);
  const { durationMillis } = useAudioRecorderState(recorder, 250);

  const start = async () => {
    setNotice(undefined);
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setNotice("denied");
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    const prepared = await Result.tryPromise(
      async () => await recorder.prepareToRecordAsync(),
    );
    if (prepared.isErr()) {
      // No recording started, so no finished status will release it.
      setNotice("failed");
      await releaseMicrophone();
      return;
    }
    keep.current = true;
    recorder.record({ forDuration: DICTATION_MAX_SECONDS });
    setPhase("recording");
  };

  const stop = async (keepRecording: boolean) => {
    keep.current = keepRecording;
    await recorder.stop();
  };

  return {
    phase,
    notice,
    elapsedMs: phase === "recording" ? durationMillis : 0,
    start: () => {
      if (starting.current || phase !== "idle") {
        return;
      }
      starting.current = true;
      start()
        .catch(() => {
          setPhase("idle");
          setNotice("failed");
        })
        .finally(() => {
          starting.current = false;
        });
    },
    finish: () => {
      stop(true).catch(() => {
        setPhase("idle");
        setNotice("failed");
      });
    },
    cancel: () => {
      stop(false).catch(() => {
        setPhase("idle");
        setNotice("failed");
      });
    },
    /** Forgets the last dictation's notice, as a sent message does. */
    dismissNotice: () => {
      setNotice(undefined);
    },
  };
};
