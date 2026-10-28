import { TaggedError } from "better-result";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sha256Hex } from "@stll/sha256/bun";

import { CLDR_EXEMPLARS } from "../src/exemplars.generated";
import { parseUnicodeSet } from "../src/unicode-set";
import input from "./cldr49-input.json";

class ExemplarInputError extends TaggedError("ExemplarInputError")<{
  message: string;
}> {}

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?$/u;
const FIELD_NAMES = ["exemplarCharacters", "auxiliary", "punctuation"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(file, "utf-8"));

export const normalizedSet = (value: unknown): string => {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ExemplarInputError({
      message: "CLDR exemplar must be a UnicodeSet string",
    });
  }
  const parsed = parseUnicodeSet(value);
  if (parsed.status === "error") {
    throw new ExemplarInputError({
      message: `Invalid CLDR exemplar: ${parsed.message}`,
    });
  }
  return [...parsed.codePoints]
    .toSorted((a, b) => a - b)
    .map((point) => String.fromCodePoint(point))
    .join("");
};

export const characterSets = (value: unknown, tag: string) => {
  const locale =
    isRecord(value) && isRecord(value["main"]) ? value["main"][tag] : undefined;
  const characters = isRecord(locale) ? locale["characters"] : undefined;
  if (!isRecord(characters)) {
    throw new ExemplarInputError({
      message: `CLDR ${tag} has no characters object`,
    });
  }
  const fields = new Map<string, string>();
  for (const field of FIELD_NAMES) {
    const raw = characters[field];
    normalizedSet(raw);
    if (typeof raw === "string") {
      fields.set(field, raw);
    }
  }
  return Object.fromEntries(fields);
};

type CompareSetsOptions = {
  expected: Record<string, string>;
  actual: Record<string, string>;
};

export const assertSameSets = ({ expected, actual }: CompareSetsOptions) => {
  for (const field of FIELD_NAMES) {
    if (normalizedSet(expected[field]) !== normalizedSet(actual[field])) {
      throw new ExemplarInputError({
        message: `Resolved CLDR source differs from npm: ${field}`,
      });
    }
  }
};

const main = () => {
  const [mode, workDirectory] = process.argv.slice(2);
  if ((mode !== "prepare" && mode !== "collect") || !workDirectory) {
    throw new ExemplarInputError({
      message:
        "Usage: refresh-exemplar-input.ts prepare|collect WORK_DIRECTORY",
    });
  }
  const npmRoot = path.join(workDirectory, "npm");
  const packageJson = readJson(path.join(npmRoot, "package.json"));
  if (!isRecord(packageJson) || packageJson["version"] !== input.version) {
    throw new ExemplarInputError({
      message: "CLDR npm input version differs from pinned source version",
    });
  }
  const primaryTags = readdirSync(path.join(npmRoot, "main"))
    .filter((tag) => LANGUAGE_TAG.test(tag))
    .toSorted();
  // Existing coverage is a compatibility contract, not a source of old data.
  const tags = [
    ...new Set([...Object.keys(CLDR_EXEMPLARS), ...primaryTags]),
  ].toSorted();
  if (tags.some((tag) => !LANGUAGE_TAG.test(tag))) {
    throw new ExemplarInputError({
      message: "CLDR coverage contains an unsupported locale identifier",
    });
  }
  if (mode === "prepare") {
    writeFileSync(
      path.join(workDirectory, "locales.regex"),
      `^(${tags.map((tag) => tag.replaceAll("-", "_")).join("|")})$`,
    );
    return;
  }
  const convertedRoot = path.join(
    workDirectory,
    "converted/cldr-misc-full/main",
  );
  const generatedTags = readdirSync(convertedRoot).toSorted();
  if (JSON.stringify(generatedTags) !== JSON.stringify(tags)) {
    throw new ExemplarInputError({
      message:
        "Official converter did not preserve the exact requested locale coverage",
    });
  }
  const primary = new Set(primaryTags);
  const supplement = new Map<string, Record<string, string>>();
  for (const tag of tags) {
    const resolved = characterSets(
      readJson(path.join(convertedRoot, tag, "characters.json")),
      tag,
    );
    if (primary.has(tag)) {
      assertSameSets({
        expected: characterSets(
          readJson(path.join(npmRoot, "main", tag, "characters.json")),
          tag,
        ),
        actual: resolved,
      });
    } else {
      supplement.set(tag, resolved);
    }
  }
  const outputRoot = path.join(workDirectory, "artifact");
  mkdirSync(outputRoot, { recursive: true });
  const data = `${JSON.stringify({ version: input.version, exemplars: Object.fromEntries(supplement) }, null, 2)}\n`;
  writeFileSync(path.join(outputRoot, "exemplars-supplement.json"), data);
  writeFileSync(
    path.join(outputRoot, "LICENSE"),
    readFileSync(path.join(npmRoot, "LICENSE")),
  );
  writeFileSync(
    path.join(outputRoot, "provenance.json"),
    `${JSON.stringify(
      {
        ...input,
        primaryLocales: primaryTags,
        supplementalLocales: [...supplement.keys()],
        totalLocales: tags.length,
        supplementSha256: sha256Hex(data),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Verified ${primary.size} primary + ${supplement.size} supplemental = ${tags.length} CLDR ${input.version} locales`,
  );
};

if (import.meta.main) {
  main();
}
