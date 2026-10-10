import { expect, test } from "bun:test";
import fc from "fast-check";

import { truncateEntityName } from "@stll/api-contract";
import { assertProperty } from "@stll/property-testing";

import { sanitizeFilename } from "@/api/lib/sanitize-filename";

import { resolveSiblingName } from "./sibling-name";

const nameArbitrary = fc.oneof(
  fc.string({ minLength: 1, maxLength: 100 }),
  fc
    .array(fc.constantFrom("😀", "é", "文", "é", "_", ".", "7"), {
      minLength: 1,
      maxLength: 35,
    })
    .map((parts) => parts.join("")),
  fc.constantFrom(
    "report_2024.docx",
    "x_1",
    ".hidden",
    "archive.tar.gz",
    "😀_2024.txt",
  ),
);

test("sibling names retain free originals and select the lowest free bounded suffix", () => {
  assertProperty(
    "sibling names retain free originals and select the lowest free bounded suffix",
    fc.property(
      nameArbitrary,
      fc.array(nameArbitrary, { maxLength: 30 }),
      fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 35 }),
      fc.boolean(),
      fc.constantFrom("document", "folder"),
      (rawName, arbitrarySiblings, numbers, occupied, kind) => {
        const name = rawName;
        const dot = kind === "document" ? name.lastIndexOf(".") : -1;
        const base = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : "";
        const siblingNames = new Set<string>(arbitrarySiblings);
        for (const number of numbers) {
          siblingNames.add(`${base}_${number}${extension}`);
        }
        if (occupied) {
          siblingNames.add(name);
        }
        const result = String(
          resolveSiblingName({ name: rawName, siblingNames, kind }),
        );
        expect(siblingNames.has(result)).toBe(false);
        expect(result.length).toBeLessThanOrEqual(255);
        expect(result.toWellFormed()).toBe(result);
        if (!siblingNames.has(name)) {
          expect(result).toBe(name);
          return;
        }
        expect(result.startsWith(`${base}_`)).toBe(true);
        expect(result.endsWith(extension)).toBe(true);
        const numberText = result.slice(
          base.length + 1,
          extension ? -extension.length : undefined,
        );
        expect(numberText).toMatch(/^[1-9]\d*$/u);
        const chosen = Number(numberText);
        const occupiedNumbers = new Set<number>();
        for (const sibling of siblingNames) {
          if (!sibling.startsWith(`${base}_`) || !sibling.endsWith(extension)) {
            continue;
          }
          const text = sibling.slice(
            base.length + 1,
            extension ? -extension.length : undefined,
          );
          if (/^[1-9]\d*$/u.test(text)) {
            occupiedNumbers.add(Number(text));
          }
        }
        expect(occupiedNumbers.has(chosen)).toBe(false);
        expect(
          Array.from({ length: chosen - 1 }, (_, index) => index + 1).every(
            (number) => occupiedNumbers.has(number),
          ),
        ).toBe(true);
      },
    ),
  );
});

test("numeric suffixes remain part of the requested name", () => {
  for (const [name, expected] of [
    ["report_2024.docx", "report_2024_1.docx"],
    ["x_1", "x_1_1"],
  ] as const) {
    expect(
      String(
        resolveSiblingName({
          name,
          kind: "document",
          siblingNames: new Set([name]),
        }),
      ),
    ).toBe(expected);
  }
});

test("folder dots remain part of the complete name", () => {
  expect(
    String(
      resolveSiblingName({
        name: "v1.2",
        kind: "folder",
        siblingNames: new Set(["v1.2"]),
      }),
    ),
  ).toBe("v1.2_1");
});

test("display names retain filename characters when the label is free", () => {
  expect(
    String(
      resolveSiblingName({
        name: "brief?.md",
        kind: "document",
        siblingNames: new Set(["brief_.md"]),
      }),
    ),
  ).toBe("brief?.md");
});

test("bounded names preserve well formed characters and free suffixes", () => {
  for (const [name, expected] of [
    [`${"a".repeat(250)}.docx`, `${"a".repeat(248)}_1.docx`],
    [`${"😀".repeat(125)}.txt`, `${"😀".repeat(124)}_1.txt`],
    [`a.${"x".repeat(253)}`, `_1.${"x".repeat(252)}`],
  ] as const) {
    const sanitized = sanitizeFilename(name);
    const result = String(
      resolveSiblingName({
        name: sanitized,
        kind: "document",
        siblingNames: new Set([sanitized]),
      }),
    );
    expect(result).toBe(expected);
    expect(result.length).toBeLessThanOrEqual(255);
    expect(result.toWellFormed()).toBe(result);
  }
});

test("numbering continues after a large occupied suffix range", () => {
  const siblingNames = new Set(["brief.docx"]);
  for (let number = 1; number <= 128; number += 1) {
    siblingNames.add(`brief_${number}.docx`);
  }
  expect(
    String(
      resolveSiblingName({
        name: "brief.docx",
        kind: "document",
        siblingNames,
      }),
    ),
  ).toBe("brief_129.docx");
});

test("long Unicode names remain bounded and free for arbitrary siblings", () => {
  const longName = fc
    .tuple(
      fc.constantFrom("a", "😀", "é", "文"),
      fc.integer({ min: 120, max: 260 }),
      fc.constantFrom("", ".docx", ".tar.gz", "_2024"),
    )
    .map(
      ([character, length, ending]) => `${character.repeat(length)}${ending}`,
    );
  assertProperty(
    "long Unicode names remain bounded and free for arbitrary siblings",
    fc.property(
      longName,
      fc.array(longName, { maxLength: 20 }),
      fc.boolean(),
      (rawName, names, occupied) => {
        const name = truncateEntityName(rawName, 255);
        const siblingNames = new Set<string>(
          names.map((value) => truncateEntityName(value, 255)),
        );
        if (occupied) {
          siblingNames.add(name);
        }
        const result = String(
          resolveSiblingName({ name, kind: "document", siblingNames }),
        );
        expect(siblingNames.has(result)).toBe(false);
        expect(result.length).toBeLessThanOrEqual(255);
        expect(result.toWellFormed()).toBe(result);
        if (!siblingNames.has(name)) {
          expect(result).toBe(name);
        } else {
          expect(result).toMatch(/_[1-9]\d*(?:\.[^.]*)?$/u);
        }
      },
    ),
  );
});

test("bounded Unicode document and folder names select gaps without moving extensions", () => {
  const prefix = fc
    .array(fc.constantFrom("😀", "é", "文", "é", "7", "_"), {
      minLength: 1,
      maxLength: 30,
    })
    .map((parts) => parts.join(""));
  assertProperty(
    "bounded Unicode document and folder names select gaps without moving extensions",
    fc.property(
      prefix,
      fc.constantFrom("document", "folder"),
      fc.uniqueArray(fc.integer({ min: 4, max: 9 }), { maxLength: 6 }),
      (head, kind, numbers) => {
        const extension = kind === "document" ? ".docx" : "";
        const beginning = kind === "folder" ? `${head}.v1.2` : head;
        const base = beginning.padEnd(255 - extension.length, "a");
        const original = `${base}${extension}`;
        // The two replaced characters are ASCII padding; every one-digit suffix
        // shares this Unicode prefix at the name-length boundary.
        const boundedStem = base.slice(0, -2);
        const siblingNames = new Set([
          original,
          `${boundedStem}_1${extension}`,
          `${boundedStem}_3${extension}`,
        ]);
        for (const number of numbers) {
          siblingNames.add(`${boundedStem}_${number}${extension}`);
        }
        expect(original.length).toBe(255);
        const expected = `${boundedStem}_2${extension}`;
        expect(siblingNames.has(expected)).toBe(false);
        const result = String(
          resolveSiblingName({ name: original, kind, siblingNames }),
        );
        expect(result).toBe(expected);
        expect(result.length).toBe(255);
        expect(result.toWellFormed()).toBe(result);
      },
    ),
  );
});

test.each(["Client: Smith", "Question?", "a*.docx", ".hidden"])(
  "copy labels preserve %s before resolving exact display collisions",
  (name) => {
    expect(
      String(
        resolveSiblingName({ name, kind: "document", siblingNames: new Set() }),
      ),
    ).toBe(name);
    const resolved = resolveSiblingName({
      name,
      kind: "document",
      siblingNames: new Set([name]),
    });
    expect(resolved).not.toBe(name);
    expect(String(resolved)).toContain(
      name.startsWith(".") ? name : (name.split(".")[0] ?? name),
    );
  },
);
