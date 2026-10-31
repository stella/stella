import { readdir, readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";

const parserFingerprintSchema = v.strictObject({
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

type ParserFingerprint = v.InferOutput<typeof parserFingerprintSchema>;

export const PARSER_FINGERPRINT_DIRECTORY = new URL(
  "replay-parser-fingerprints/",
  import.meta.url,
);

const fingerprintUrl = (key: string, directory: URL) => {
  v.parse(v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)), key);
  return new URL(`${key}.json`, directory);
};

export const loadParserFingerprint = async (
  key: string,
  directory = PARSER_FINGERPRINT_DIRECTORY,
) =>
  v.parse(
    parserFingerprintSchema,
    JSON.parse(await readFile(fingerprintUrl(key, directory), "utf-8")),
  );

export const loadParserFingerprints = async (
  directory = PARSER_FINGERPRINT_DIRECTORY,
) => {
  const entries = await readdir(directory);
  return v.parse(
    v.record(v.string(), parserFingerprintSchema),
    Object.fromEntries(
      await Promise.all(
        entries.map(async (name) => {
          const key = name.replace(/\.json$/u, "");
          v.parse(v.literal(`${key}.json`), name);
          return [key, await loadParserFingerprint(key, directory)];
        }),
      ),
    ),
  );
};

type WriteParserFingerprintOptions = {
  key: string;
  fingerprint: ParserFingerprint;
  directory?: URL;
};

export const writeParserFingerprint = async ({
  key,
  fingerprint,
  directory = PARSER_FINGERPRINT_DIRECTORY,
}: WriteParserFingerprintOptions) => {
  const output = `${JSON.stringify(v.parse(parserFingerprintSchema, fingerprint), null, 2)}\n`;
  const file = fingerprintUrl(key, directory);
  // Comparing bytes leaves every unchanged parser file untouched.
  const current = Bun.file(file);
  if ((await current.exists()) && (await current.text()) === output) {
    return;
  }
  await writeFile(file, output);
};
