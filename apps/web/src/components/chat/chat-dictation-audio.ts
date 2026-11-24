import { MAX_TRANSCRIPTION_AUDIO_SECONDS } from "@stll/api-contract/transcription";

const SAMPLE_RATE = 16_000;
const WAV_HEADER_BYTES = 44;

/** Recording stops itself a second short of the most audio one transcription takes. */
export const DICTATION_MAX_MS = (MAX_TRANSCRIPTION_AUDIO_SECONDS - 1) * 1000;

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
export const recordingToWav = async (recording: Blob): Promise<File> => {
  // Decoding in a context at 16 kHz resamples as it decodes.
  const decoded = await new OfflineAudioContext(
    1,
    1,
    SAMPLE_RATE,
  ).decodeAudioData(await recording.arrayBuffer());
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    for (const [index, sample] of decoded.getChannelData(channel).entries()) {
      mono[index] = (mono[index] ?? 0) + sample / decoded.numberOfChannels;
    }
  }
  return new File([encodeWav(mono, SAMPLE_RATE)], "dictation.wav", {
    type: "audio/wav",
  });
};
