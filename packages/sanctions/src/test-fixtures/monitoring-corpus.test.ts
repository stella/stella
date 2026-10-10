import { expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/node";

import {
  syntheticMonitoringEntry,
  syntheticMonitoringName,
} from "./monitoring-corpus";

// Pinned outputs were independently computed with Python hashlib SHA-256.
const vectors = [
  {
    index: 0,
    name: "kkpihakkflbkahbk bapjblaaglminedp",
  },
  {
    index: 1,
    name: "hdcfjfnffmhkncmm loglgikfeehdaoin",
  },
  {
    index: 9999,
    name: "anghkfdgfhikpadf dpeabcoljkaagmah",
  },
  {
    index: 19_999,
    name: "anbhlmcfmmgomlfi jbgjdcighkbiklho",
  },
  {
    index: -1,
    name: "enfcikabnjcfjncl jhapalallmpgmmnp",
  },
  {
    index: 123_456,
    name: "gjpeacijhiijaipp binencbikjakhnph",
  },
] as const;

for (const { index, name } of vectors) {
  test(`monitoring fixture identities retain numeric seed and hexadecimal name mapping: ${String(index)}`, () => {
    const hex = sha256Hex(`synthetic-person-${String(index)}`).slice(0, 32);
    const letters = Array.from(hex, (digit) =>
      String.fromCodePoint(97 + Number.parseInt(digit, 16)),
    ).join("");
    const previous = `${letters.slice(0, 16)} ${letters.slice(16)}`;
    expect(syntheticMonitoringName(index)).toBe(name);
    expect(syntheticMonitoringName(index)).toBe(previous);
    expect(syntheticMonitoringEntry(index).names).toEqual([
      { name, quality: "strong" },
    ]);
    expect(syntheticMonitoringEntry(index).sourceId).toBe(String(index));
  });
}
