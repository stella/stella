const RATE = 16_000;

/** Mono 16-bit WAV: a loud tone for four seconds, then a second of quiet. */
export const toneWav = (seconds: number): Uint8Array => {
  const samples = seconds * RATE;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    bytes.set(new TextEncoder().encode(text), offset);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const quiet = Math.floor(index / RATE) % 5 === 4;
    const value = quiet
      ? 0
      : Math.round(Math.sin((index * 440 * 2 * Math.PI) / RATE) * 16_000);
    view.setInt16(44 + index * 2, value, true);
  }
  return bytes;
};
