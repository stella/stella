#!/usr/bin/env bun

// Writes src/exemplars.generated.ts from the CLDR exemplar characters in the
// pinned `cldr-misc-full` package: one entry per language (and per
// language-script pair), never a regional variant, since a region does not
// change which letters a language writes. `exemplars.test.ts` compares the
// table with a fresh extraction, so a dependency bump without a regeneration
// fails.
//
//   bun scripts/extract-exemplars.ts

import { panic } from "better-result";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { sha256Hex } from "@stll/sha256/bun";

import { parseUnicodeSet } from "../src/unicode-set.js";
import input from "./cldr49-input.json";

const OUTPUT = path.resolve(import.meta.dir, "../src/exemplars.generated.ts");

/** A language, or a language written in a named script; never a region. */
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?$/u;

/** Our field name, then the CLDR key it is read from. */
const EXEMPLAR_FIELDS = [
  ["main", "exemplarCharacters"],
  ["auxiliary", "auxiliary"],
  ["punctuation", "punctuation"],
] as const;

type ExemplarField = (typeof EXEMPLAR_FIELDS)[number][0];

export type ExtractedExemplars = {
  version: string;
  /** The CLDR package's own LICENSE: the data's licence, not this code's. */
  license: string;
  exemplars: Record<string, Record<ExemplarField, string>>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(file, "utf-8"));

/** `{ main: { <tag>: { characters: {...} } } }` → the characters block. */
const charactersBlock = (
  tag: string,
  file: unknown,
): Record<string, unknown> => {
  const locale =
    isObject(file) && isObject(file["main"]) ? file["main"][tag] : undefined;
  const block = isObject(locale) ? locale["characters"] : undefined;
  return isObject(block) ? block : panic(`CLDR ${tag}: no characters block`);
};

const setString = (tag: string, raw: unknown): string => {
  if (raw === undefined) {
    return "";
  }
  if (typeof raw !== "string") {
    return panic(`CLDR ${tag}: exemplar set is not a string`);
  }
  const parsed = parseUnicodeSet(raw);
  if (parsed.status === "error") {
    return panic(`CLDR ${tag}: ${parsed.message}`);
  }
  return [...parsed.codePoints]
    .toSorted((a, b) => a - b)
    .map((cp) => String.fromCodePoint(cp))
    .join("");
};

type ValidateSupplementOptions = {
  version: string;
  primaryTags: string[];
  data: string;
  provenance: unknown;
};

export const validateSupplement = ({
  version,
  primaryTags,
  data,
  provenance,
}: ValidateSupplementOptions) => {
  const supplement: unknown = JSON.parse(data);
  if (
    !isObject(supplement) ||
    !isObject(supplement["exemplars"]) ||
    !isObject(provenance)
  ) {
    return panic("CLDR supplement has no exemplar or provenance object");
  }
  if (
    version !== input.version ||
    supplement["version"] !== version ||
    provenance["version"] !== version ||
    provenance["sourceCommit"] !== input.sourceCommit ||
    JSON.stringify(provenance["sources"]) !== JSON.stringify(input.sources) ||
    JSON.stringify(provenance["converterOptions"]) !==
      JSON.stringify(input.converterOptions)
  ) {
    return panic(
      "CLDR supplement must match the pinned npm and source release",
    );
  }
  // The producer hashes this serialization; repository formatting may change whitespace.
  if (
    sha256Hex(`${JSON.stringify(supplement, null, 2)}\n`) !==
    provenance["supplementSha256"]
  ) {
    return panic("CLDR supplement digest differs from verified provenance");
  }
  const exemplars = supplement["exemplars"];
  const supplementalTags = Object.keys(exemplars).toSorted();
  if (
    JSON.stringify(primaryTags) !==
      JSON.stringify(provenance["primaryLocales"]) ||
    JSON.stringify(supplementalTags) !==
      JSON.stringify(provenance["supplementalLocales"]) ||
    primaryTags.length + supplementalTags.length !==
      provenance["totalLocales"] ||
    supplementalTags.some(
      (tag) => !LANGUAGE_TAG.test(tag) || primaryTags.includes(tag),
    )
  ) {
    return panic("CLDR supplement coverage differs from verified provenance");
  }
  return exemplars;
};

export const extractExemplars = (): ExtractedExemplars => {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("cldr-misc-full/package.json");
  const packageRoot = path.dirname(packageJsonPath);
  const manifest = readJson(packageJsonPath);
  const version = isObject(manifest) ? manifest["version"] : undefined;
  if (typeof version !== "string") {
    return panic("cldr-misc-full/package.json has no version");
  }
  const license = readFileSync(path.join(packageRoot, "LICENSE"), "utf-8");
  const exemplars: ExtractedExemplars["exemplars"] = {};
  const primaryTags = readdirSync(path.join(packageRoot, "main"))
    .filter((tag) => LANGUAGE_TAG.test(tag))
    .toSorted();
  const supplementRoot = path.resolve(import.meta.dir, "../data/cldr49");
  const supplement = validateSupplement({
    version,
    primaryTags,
    data: readFileSync(
      path.join(supplementRoot, "exemplars-supplement.json"),
      "utf-8",
    ),
    provenance: readJson(path.join(supplementRoot, "provenance.json")),
  });
  const tags = [...primaryTags, ...Object.keys(supplement)].toSorted();
  for (const tag of tags) {
    const raw = primaryTags.includes(tag)
      ? charactersBlock(
          tag,
          readJson(path.join(packageRoot, "main", tag, "characters.json")),
        )
      : supplement[tag];
    const block = isObject(raw)
      ? raw
      : panic(`CLDR ${tag}: invalid supplement characters`);
    exemplars[tag] = {
      main: setString(tag, block["exemplarCharacters"]),
      auxiliary: setString(tag, block["auxiliary"]),
      punctuation: setString(tag, block["punctuation"]),
    };
  }
  return { version, license, exemplars };
};

/**
 * The generated file's opening comment. The table is derived from CLDR data,
 * so it carries that data's notice, which the Unicode licence requires with
 * every copy; the code around it is the package's own Apache-2.0.
 */
export const generatedHeader = ({
  license,
}: Pick<ExtractedExemplars, "license">): string =>
  [
    "// Generated by ./scripts/extract-exemplars.ts from the CLDR exemplar",
    "// characters in cldr-misc-full and the verified same-release supplement. Do not edit manually.",
    "//",
    "// The data below is derived from the Unicode CLDR and is licensed under",
    "// the Unicode License v3, not under this package's Apache-2.0:",
    "//",
    ...license
      .trim()
      .split("\n")
      .map((line) => (line.length === 0 ? "//" : `// ${line}`)),
    "",
  ].join("\n");

const render = (extracted: ExtractedExemplars): string => {
  const { version, exemplars } = extracted;
  const lines = [
    generatedHeader(extracted),
    `export const CLDR_VERSION = ${JSON.stringify(version)};`,
    "",
    "export const CLDR_EXEMPLARS = {",
  ];
  for (const [tag, sets] of Object.entries(exemplars)) {
    lines.push(`  ${JSON.stringify(tag)}: {`);
    for (const [field] of EXEMPLAR_FIELDS) {
      lines.push(`    ${field}: ${JSON.stringify(sets[field])},`);
    }
    lines.push("  },");
  }
  lines.push("} as const;", "");
  return lines.join("\n");
};

if (import.meta.main) {
  writeFileSync(OUTPUT, render(extractExemplars()));
}
