const utf8Decoder = new TextDecoder();

/** Serialize JSON as deterministic, maximum-compression gzip bytes. */
export const encodeGzipJson = (value: unknown): Uint8Array<ArrayBuffer> =>
  Bun.gzipSync(Buffer.from(`${JSON.stringify(value, null, 2)}\n`), {
    level: 9,
  });

/** Read and parse a gzip-compressed JSON file. */
export const readGzipJson = async (file: string | URL): Promise<unknown> => {
  const compressed = await Bun.file(file).bytes();
  return JSON.parse(utf8Decoder.decode(Bun.gunzipSync(compressed)));
};
