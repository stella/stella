import { describe, expect, test } from "bun:test";

import {
  ENCODING_SAMPLES_MAX_CHARS,
  textMisdecodedFields,
} from "@/api/lib/legal-search/parsers/text-encoding";

// Slovak Constitutional Court, I. ÚS 66/98, as the publisher serves it:
// windows-1250 text read as windows-1252 before it reached the corpus.
const PUBLISHED =
  "Ústavný súd Slovenskej republiky v Košiciach na neverejnom zasadnutí senátu konanom 15. októbra 1998 predbežne prerokoval podnet O. Z., bytom B., vo veci porušenia jeho základného práva pod¾a èl. 46 ods. 1 Ústavy Slovenskej republiky a ¾udského práva pod¾a èl. 6 ods. 1 Dohovoru o ochrane ¾udských práv a základných slobôd. Z jeho obsahu vyplynulo, že navrhovate¾ sa svojím návrhom na zaèatie konania domáhal zaplatenia náhrady.";

// The same text as the court wrote it.
const WRITTEN =
  "Ústavný súd Slovenskej republiky v Košiciach na neverejnom zasadnutí senátu konanom 15. októbra 1998 predbežne prerokoval podnet O. Z., bytom B., vo veci porušenia jeho základného práva podľa čl. 46 ods. 1 Ústavy Slovenskej republiky a ľudského práva podľa čl. 6 ods. 1 Dohovoru o ochrane ľudských práv a základných slobôd. Z jeho obsahu vyplynulo, že navrhovateľ sa svojím návrhom na začatie konania domáhal zaplatenia náhrady.";

describe("a stored text read through the wrong charset", () => {
  test("is reported with the pair and the words that show it", () => {
    expect(textMisdecodedFields(PUBLISHED, "sk")).toEqual({
      encodingKinds: "misdecoded",
      encodingPair: "windows-1250>windows-1252",
      encodingLayers: 1,
      encodingConfidence: 1,
      encodingSamples: `pod¾a@${String(PUBLISHED.indexOf("pod¾a"))}→podľa; èl.@${String(PUBLISHED.indexOf("èl."))}→čl.; ¾udského@${String(PUBLISHED.indexOf("¾udského"))}→ľudského`,
    });
  });

  test("the same text as written is not", () => {
    expect(textMisdecodedFields(WRITTEN, "sk")).toBeUndefined();
  });

  test("a sample is capped however long the word it stands in", () => {
    // Text with no whitespace is one word: OCR output, a payload, a
    // space-free script. Its sample must not carry the document.
    for (const length of [0, 119, 120, 121, 100_000]) {
      const word = `${"a".repeat(length)}�`;
      const text = [word, word, WRITTEN, word].join(" ");
      const fields = textMisdecodedFields(text, "sk");
      const samples = fields?.encodingSamples ?? "";
      expect(samples.length).toBeLessThanOrEqual(ENCODING_SAMPLES_MAX_CHARS);
      expect(samples.startsWith(word.slice(0, 120))).toBe(true);
      expect(samples.includes("…[+")).toBe(word.length > 120);
      expect(samples).toContain(`@${String(word.length + 1)}`);
    }
  });

  test("a cut sample never splits a surrogate pair", () => {
    for (const prefix of ["", "a"]) {
      const word = `${prefix}${"😀".repeat(100)}�`;
      const samples =
        textMisdecodedFields(`${word} ${WRITTEN}`, "sk")?.encodingSamples ?? "";
      expect(samples).toContain("…[+");
      expect(samples.isWellFormed()).toBe(true);
    }
  });

  test("a mis-decoded sample and its repair are each capped", () => {
    const long = `pod¾a${"x".repeat(500)}`;
    const text = `${long} ${long} ${PUBLISHED}`;
    const samples = textMisdecodedFields(text, "sk")?.encodingSamples ?? "";
    expect(samples).toContain(`pod¾axxx`);
    expect(samples).toContain(`→podľaxxx`);
    expect(samples.length).toBeLessThanOrEqual(ENCODING_SAMPLES_MAX_CHARS);
  });

  test("lost bytes are reported without a pair", () => {
    const lost = WRITTEN.replaceAll("ľ", "�");
    expect(textMisdecodedFields(lost, "sk")?.encodingKinds).toBe(
      "replacement-character",
    );
  });
});
