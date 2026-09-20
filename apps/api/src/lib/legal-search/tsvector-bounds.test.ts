import { expect, test } from "bun:test";

import { boundTsvectorText } from "@/api/lib/legal-search/tsvector-bounds";

const REPLACEMENT_CHARACTER = "�";

// Seeds whose repetition puts the byte bound in a different place: inside a
// two-byte Czech letter, inside a three-byte Japanese one, and on an ASCII
// boundary. A statute carries all three across the jurisdictions indexed.
const SEEDS = [
  "ustanoveni odstavce pismene",
  "žádost účastníka řízení",
  "行政訴訟 判決 理由",
] as const;

const grow = (seed: string, minimumBytes: number): string => {
  const parts: string[] = [];
  let bytes = 0;
  let index = 0;
  while (bytes < minimumBytes) {
    const part = `${seed}${index}`;
    parts.push(part);
    bytes += Buffer.byteLength(part) + 1;
    index += 1;
  }
  return parts.join(" ");
};

test("text that projects within the ceiling is handed back whole", () => {
  const text = "CZ/2012/90 Zákon o obchodních korporacích";
  expect(boundTsvectorText(text)).toBe(text);
});

test("bounded text is a shorter prefix that splits neither a character nor a word", () => {
  for (const seed of SEEDS) {
    const text = grow(seed, 2 * 1024 * 1024);
    const bounded = boundTsvectorText(text);

    expect(text.startsWith(bounded)).toBe(true);
    expect(Buffer.byteLength(bounded)).toBeLessThan(Buffer.byteLength(text));
    expect(bounded).not.toContain(REPLACEMENT_CHARACTER);
    expect(text.charAt(bounded.length)).toMatch(/\s/u);
  }
});

test("bounding text that is already bounded changes nothing", () => {
  for (const seed of SEEDS) {
    const bounded = boundTsvectorText(grow(seed, 2 * 1024 * 1024));
    expect(boundTsvectorText(bounded)).toBe(bounded);
  }
});

test("a single token longer than the bound keeps its prefix", () => {
  const token = "§".repeat(1024 * 1024);
  const bounded = boundTsvectorText(token);

  expect(bounded).not.toBe("");
  expect(token.startsWith(bounded)).toBe(true);
  expect(bounded).not.toContain(REPLACEMENT_CHARACTER);
});
