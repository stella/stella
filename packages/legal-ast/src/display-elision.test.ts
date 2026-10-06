import { describe, expect, test } from "bun:test";

import {
  DISPLAY_ELISION_KIND,
  displayElisions,
  drawnText,
} from "./display-elision.js";

const drawn = (text: string): string => drawnText(text, displayElisions(text));

describe("a quotation mark the publisher printed escaped", () => {
  // As rozhodnuti.nsoud.cz serves 21 Cdo 1484/2004: `\&quot;` throughout.
  const SENTENCE =
    'Žalobce se domáhal, aby bylo určeno, že \\"smlouva o půjčce ' +
    'uzavřená dne 4.10.1999 je neplatná\\", že \\"žalovaný nemá ' +
    'zástavní právo\\".';

  test("is drawn without the backslash, which stays in the text", () => {
    const elisions = displayElisions(SENTENCE);

    expect(drawnText(SENTENCE, elisions)).toBe(
      'Žalobce se domáhal, aby bylo určeno, že "smlouva o půjčce ' +
        'uzavřená dne 4.10.1999 je neplatná", že "žalovaný nemá ' +
        'zástavní právo".',
    );
    expect(elisions).toHaveLength(4);
    for (const { kind, start, end } of elisions) {
      expect(kind).toBe(DISPLAY_ELISION_KIND.ESCAPED_QUOTE);
      expect(SENTENCE.slice(start, end + 1)).toBe('\\"');
    }
  });

  test("keeps every backslash where the quotation marks are not all escaped", () => {
    for (const text of [
      'Cesta C:\\Users\\"spis" zůstává, jak ji soud uvedl.',
      'Výraz \\"manko\\" a "škoda" stojí vedle sebe.',
    ]) {
      expect(displayElisions(text)).toEqual([]);
    }
  });
});

describe("a letter-spaced word", () => {
  test("is drawn as the word, its source characters untouched", () => {
    const heading = "O d ů v o d n ě n í :";

    expect(drawn(heading)).toBe("Odůvodnění:");
    expect(displayElisions(heading)).toEqual(
      [1, 3, 5, 7, 9, 11, 13, 15, 17, 19].map((start) => ({
        kind: DISPLAY_ELISION_KIND.LETTER_SPACING,
        start,
        end: start + 1,
      })),
    );
  });

  test("keeps the gap between two spaced words and the words around them", () => {
    expect(drawn("Soud t a k t o  r o z h o d l : dovolání se zamítá.")).toBe(
      "Soud takto  rozhodl: dovolání se zamítá.",
    );
    expect(drawn("U S N E S E N Í")).toBe("USNESENÍ");
  });

  test("leaves Czech one-letter words and ordinary prose alone", () => {
    for (const text of [
      "Soud k a v rozhodl.",
      "s ohledem na § 237 odst. 1 písm. a) o. s. ř.",
      "Nejvyšší soud České republiky rozhodl v senátě.",
    ]) {
      expect(displayElisions(text)).toEqual([]);
    }
  });
});
