import { useEffect, useRef, useState } from "react";

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
  // Which start is current: a sent message or a closed composer moves it on,
  // so a start still opening the microphone stops before it records.
  const attempt = useRef(0);

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
    // A microphone that could not be handed back is reported, but the
    // recording is still good to transcribe.
    const released = await Result.tryPromise(releaseMicrophone);
    if (status.hasError || released.isErr()) {
      setNotice("failed");
    }
    const { url } = status;
    if (url === null) {
      return;
    }
    const transcribed =
      !status.hasError && keep.current
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

  const start = async (id: number) => {
    setNotice(undefined);
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
    keep.current = true;
    recorder.record({ forDuration: DICTATION_MAX_SECONDS });
    setPhase("recording");
  };

  const stop = async (keepRecording: boolean) => {
    keep.current = keepRecording;
    await recorder.stop();
  };

  // A composer that closes mid-dictation, as on leaving the thread, drops
  // the recording: the recorder's own release reports no finished status, so
  // the microphone and the file are let go here.
  // With the composer gone, a failure here has nowhere to show; each step
  // still runs after the one before it fails.
  useEffect(
    () => () => {
      attempt.current += 1;
      if (!recorder.isRecording) {
        return;
      }
      const { uri } = recorder;
      keep.current = false;
      void (async () => {
        await Result.tryPromise(async () => await recorder.stop());
        await Result.tryPromise(releaseMicrophone);
        if (uri !== null) {
          discardRecording(uri);
        }
      })();
    },
    [recorder],
  );

  return {
    phase,
    notice,
    elapsedMs: phase === "recording" ? durationMillis : 0,
    start: () => {
      if (starting.current || phase !== "idle") {
        return;
      }
      starting.current = true;
      attempt.current += 1;
      start(attempt.current)
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
    /**
     * What a sent message does to dictation: forgets the last notice and
     * stops a start still opening the microphone from recording.
     */
    settleForSend: () => {
      attempt.current += 1;
      setNotice(undefined);
    },
  };
};
