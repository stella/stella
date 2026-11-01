import { useRef, useState } from "react";

import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import type { RecordingOptions, RecordingStatus } from "expo-audio";

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

/**
 * The composer's microphone. `start` asks for the microphone the first
 * time, then records; `finish` stops and sends the recording to be
 * transcribed, and the text goes to `onText`; `cancel` drops it. A
 * recording that reaches the transcription's limit of a minute stops by
 * itself and is transcribed like a finished one.
 */
export const useDictation = (onText: (text: string) => void) => {
  const { state } = useSession();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [notice, setNotice] = useState<DictationNotice>();
  // What a stop means, read when the recorder reports it: a recording that
  // stops by itself at the limit is kept.
  const keep = useRef(true);

  const transcribe = async (uri: string) => {
    if (state.status !== "signed-in") {
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    const result = await transcribeRecording({
      fetch,
      source: state.source,
      uri,
    });
    setPhase("idle");
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

  const onStatus = (status: RecordingStatus) => {
    if (!status.isFinished) {
      return;
    }
    // Hand the microphone back, so other apps' audio resumes.
    setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    if (status.hasError || status.url === null) {
      setPhase("idle");
      setNotice(status.hasError ? "failed" : undefined);
      return;
    }
    if (!keep.current) {
      setPhase("idle");
      return;
    }
    transcribe(status.url).catch(() => {
      setPhase("idle");
      setNotice("failed");
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
    await recorder.prepareToRecordAsync();
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
      start().catch(() => {
        setPhase("idle");
        setNotice("failed");
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
      });
    },
  };
};
