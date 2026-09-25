import { describe, expect, test } from "bun:test";

import { textMisdecodedFields } from "@/api/lib/legal-search/parsers/text-encoding";

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

  test("lost bytes are reported without a pair", () => {
    const lost = WRITTEN.replaceAll("ľ", "�");
    expect(textMisdecodedFields(lost, "sk")?.encodingKinds).toBe(
      "replacement-character",
    );
  });
});
