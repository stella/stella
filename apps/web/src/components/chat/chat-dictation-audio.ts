import { Result } from "better-result";

import { MAX_TRANSCRIPTION_AUDIO_SECONDS } from "@stll/api-contract/transcription";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import { composerText } from "@/components/chat-editor-source";
import type { ComposerContextMenuProps } from "@/components/chat/composer-plus-menu";
import { getLiveEditor } from "@/components/live-editor";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { toAPIError } from "@/lib/errors/api";

const SAMPLE_RATE = 16_000;
const WAV_HEADER_BYTES = 44;

/** Maximum mono samples accepted by the transcription route at 16 kHz. */
const MAX_DICTATION_SAMPLES = MAX_TRANSCRIPTION_AUDIO_SECONDS * SAMPLE_RATE;

/** Recording stops itself a second short of the most audio one transcription takes. */
const DICTATION_MAX_MS = (MAX_TRANSCRIPTION_AUDIO_SECONDS - 1) * 1000;

export type DictationRecording = {
  recorder: MediaRecorder;
  stream: MediaStream;
  timer: ReturnType<typeof setTimeout>;
};

type DictationTranscribeOutcome =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "silent" }
  | { readonly type: "error"; readonly error: unknown };

type DictationStartOutcome =
  | { readonly type: "started"; readonly recording: DictationRecording }
  | { readonly type: "denied" }
  | { readonly type: "cancelled" }
  | { readonly type: "error"; readonly error: unknown };

const stopTracks = (stream: MediaStream) => {
  for (const track of stream.getTracks()) {
    track.stop();
  }
};

export const releaseDictationRecording = ({
  stream,
  timer,
}: DictationRecording) => {
  clearTimeout(timer);
  stopTracks(stream);
};

/** Mixes decoded audio channels into a mono buffer bounded to the server duration limit. */
export const mixChannelsToMono = (
  channels: readonly Float32Array[],
  maxSamples = MAX_DICTATION_SAMPLES,
): Float32Array => {
  const firstChannel = channels.at(0);
  if (firstChannel === undefined) {
    return new Float32Array(0);
  }
  const sampleCount = Math.min(firstChannel.length, maxSamples);
  const mono = new Float32Array(sampleCount);
  const channelCount = channels.length;
  for (const channel of channels) {
    const limit = Math.min(channel.length, sampleCount);
    for (let index = 0; index < limit; index++) {
      mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0) / channelCount;
    }
  }
  return mono;
};

/** 16-bit PCM WAV, the one recorded format every browser can produce that
 *  the transcription route reads the duration of. */
export const encodeWav = (samples: Float32Array, sampleRate: number): Blob => {
  const view = new DataView(
    new ArrayBuffer(WAV_HEADER_BYTES + samples.length * 2),
  );
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(offset + index, text.codePointAt(index) ?? 0);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (const [index, sample] of samples.entries()) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      WAV_HEADER_BYTES + index * 2,
      Math.round(clamped < 0 ? clamped * 0x80_00 : clamped * 0x7f_ff),
      true,
    );
  }
  return new Blob([view.buffer], { type: "audio/wav" });
};

/** The browser's recording (WebM, Ogg or MP4) as mono 16 kHz WAV. */
const recordingToWav = async (recording: Blob): Promise<File> => {
  // Decoding in a context at 16 kHz resamples as it decodes.
  const decoded = await new OfflineAudioContext(
    1,
    1,
    SAMPLE_RATE,
  ).decodeAudioData(await recording.arrayBuffer());
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    channels.push(decoded.getChannelData(channel));
  }
  const mono = mixChannelsToMono(channels, MAX_DICTATION_SAMPLES);
  return new File([encodeWav(mono, SAMPLE_RATE)], "dictation.wav", {
    type: "audio/wav",
  });
};

export const applyDictatedText = (
  controller: Pick<ChatEditorController, "editor" | "focus" | "setContent">,
  text: string,
) => {
  const liveEditor = getLiveEditor(controller.editor);
  if (liveEditor === null) {
    return;
  }
  if (liveEditor.isEmpty) {
    controller.setContent(composerText(text));
    controller.focus();
    return;
  }
  const separator = /\s$/u.test(liveEditor.getText()) ? "" : " ";
  liveEditor
    .chain()
    .focus("end")
    .insertContent({ type: "text", text: `${separator}${text}` })
    .run();
};

export const transcribeDictationAudio = async ({
  audio,
  context,
}: {
  audio: Blob;
  context: Pick<ComposerContextMenuProps, "threadRef"> | undefined;
}): Promise<DictationTranscribeOutcome> => {
  const result = await Result.tryPromise(async () => {
    const file = await recordingToWav(audio);
    return await invokeCapability("dictation.transcribe", (request) =>
      api.dictation.transcribe.post(
        {
          file,
          ...(context?.threadRef.scope === "workspace"
            ? { matterId: context.threadRef.workspaceId }
            : {}),
        },
        request,
      ),
    );
  });
  if (Result.isError(result)) {
    return { type: "error", error: result.error };
  }
  if (result.value.error) {
    return { type: "error", error: toAPIError(result.value.error) };
  }
  const text = result.value.data.text.trim();
  if (text === "") {
    return { type: "silent" };
  }
  return { type: "text", text };
};

export const acquireAndStartRecording = async ({
  isStillValid,
  onStop,
}: {
  isStillValid: () => boolean;
  onStop: (audio: Blob, recorder: MediaRecorder) => void;
}): Promise<DictationStartOutcome> => {
  const streamResult = await Result.tryPromise(
    async () => await navigator.mediaDevices.getUserMedia({ audio: true }),
  );
  if (Result.isError(streamResult)) {
    return isStillValid() ? { type: "denied" } : { type: "cancelled" };
  }

  const stream = streamResult.value;
  if (!isStillValid()) {
    stopTracks(stream);
    return { type: "cancelled" };
  }

  const startResult = Result.try(() => {
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      chunks.push(event.data);
    };
    recorder.onstop = () => {
      onStop(new Blob(chunks, { type: recorder.mimeType }), recorder);
    };
    recorder.start();
    const timer = setTimeout(() => {
      recorder.stop();
    }, DICTATION_MAX_MS);
    return { recorder, stream, timer };
  });

  if (Result.isError(startResult)) {
    stopTracks(stream);
    return { type: "error", error: startResult.error };
  }

  return { type: "started", recording: startResult.value };
};
