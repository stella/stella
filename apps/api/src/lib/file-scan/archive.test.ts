import { compile } from "@litko/yara-x";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";

import { assertProperty } from "@stll/property-testing";

import {
  ARCHIVE_REFUSAL_RULES,
  createArchiveContentScanner,
} from "@/api/lib/file-scan/archive";
import type { ArchiveInspectionBudget } from "@/api/lib/file-scan/archive";
import { mapMatchFinding } from "@/api/lib/file-scan/pipeline";
import { createZipBombGuard } from "@/api/lib/file-scan/scanner";
import type { Match } from "@/api/lib/file-scan/scanner";
import { aggregateVerdict } from "@/api/lib/file-scan/verdict";
import {
  YARA_MAX_MATCH_BYTES,
  yaraRuleNames,
  yaraScanner,
  yaraWindowedRuleNames,
  yaraWindowedRules,
} from "@/api/lib/file-scan/yara";

// Never fires, so every verdict below comes from inspecting the entries.
const permissiveGuard = createZipBombGuard({
  maxEntries: 1000,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 1_000_000,
});

const OVERLAP = YARA_MAX_MATCH_BYTES - 1;
// Small steps put a window boundary every few dozen bytes.
const STEP = 41;

const budgetWithStep = (step: number): ArchiveInspectionBudget => ({
  windowBytes: OVERLAP + step,
  maxEvidenceBytes: 4 * 1024 * 1024,
  timeBudgetMs: 600_000,
});

const REFUSAL_BUDGET = budgetWithStep(512);

const scanArchive = async (
  bytes: Uint8Array,
  budget: ArchiveInspectionBudget,
  now?: () => number,
): Promise<Match[]> =>
  await createArchiveContentScanner({
    rules: yaraWindowedRules,
    budget,
    guard: permissiveGuard,
    ...(now === undefined ? {} : { now }),
  }).scan(bytes);

const verdictOf = (matches: readonly Match[]) =>
  aggregateVerdict(matches.map(mapMatchFinding));

const rulesOf = (matches: readonly Match[]): string[] =>
  matches.map(({ rule }) => rule).toSorted();

type Entry = { name: string; content: Buffer };
type Compression = "STORE" | "DEFLATE";

const zipOf = async (
  entries: readonly Entry[],
  compression: Compression = "DEFLATE",
): Promise<Uint8Array> => {
  const zip = new JSZip();
  for (const { name, content } of entries) {
    zip.file(name, content);
  }
  return await zip.generateAsync({ type: "uint8array", compression });
};

// The oracle: the archive as one buffer, every entry name and content whole,
// laid out as inspection lays out its evidence (separate pieces past a
// 64-byte pad).
const SEPARATOR = Buffer.from([0xff, 0x3e, 0xff]);
const wholeArchiveRules = async (
  entries: readonly Entry[],
): Promise<string[]> =>
  rulesOf(
    await yaraScanner.scan(
      Buffer.concat([
        Buffer.alloc(64, 0xff),
        ...entries.flatMap(({ name, content }) => [
          Buffer.from(name),
          SEPARATOR,
          content,
          SEPARATOR,
        ]),
      ]),
    ),
  );

const RELATIONSHIP =
  '<Relationship Id="r1" Type="x/oleObject" Target="t" TargetMode="External"/>';
const HYPERLINK =
  '<Relationship Id="r2" Type="x/hyperlink" Target="t" TargetMode="External"/>';

// Snippets that make rules fire, alone or combined, and snippets that keep
// the counting rule from firing.
const MARKERS = [
  "<w:instrText>DDEAUTO c</w:instrText>",
  "instrText",
  "DDEAUTO ",
  "<!ENTITY e ",
  ' SYSTEM "x"',
  "vbaProject.bin",
  "activeX",
  "oleObject",
  "AutoOpen",
  'CreateObject("x")',
  RELATIONSHIP,
  HYPERLINK,
  HYPERLINK,
  "MZ",
  "PE\u0000\u0000",
  "<svg ",
  "<script>",
  `onload${" ".repeat(3000)}=`,
  "%PDF-",
  "/JS ",
  "/XFA ",
  "/AcroForm ",
] as const;

const NAMES = [
  "[Content_Types].xml",
  "word/document.xml",
  "word/vbaProject.bin",
  "word/_rels/document.xml.rels",
  "word/activeX/activeX1.xml",
] as const;

const FILLER = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz <>/=\"'\n".split("")), {
    maxLength: 9000,
  })
  .map((chars) => chars.join(""));

const entryArbitrary = fc
  .record({
    name: fc.constantFrom(...NAMES),
    filler: FILLER,
    markers: fc.array(
      fc.record({ marker: fc.constantFrom(...MARKERS), at: fc.nat() }),
      { maxLength: 4 },
    ),
  })
  .map(({ name, filler, markers }): Entry => {
    let content = filler;
    for (const { marker, at } of markers) {
      const position = at % (content.length + 1);
      content = content.slice(0, position) + marker + content.slice(position);
    }
    return { name, content: Buffer.from(content, "latin1") };
  });

// Entry names stay unique (a repeated name is refused) and keep the OOXML
// part name as a suffix for the rules that look for one.
const uniqueNames = (entries: readonly Entry[]): Entry[] =>
  entries.map((entry, index) => ({ ...entry, name: `${index}/${entry.name}` }));

describe("windowed rule set", () => {
  test("covers every compiled rule", () => {
    expect(yaraWindowedRuleNames.toSorted()).toEqual(
      [...yaraRuleNames].toSorted(),
    );
    expect([...yaraWindowedRules.countingRules]).toEqual([
      "ooxml_external_relationship",
    ]);
  });

  test("the engine reports no match longer than the window overlap allows", () => {
    // Windows overlap by one byte less than this bound; a longer reported
    // match could straddle two windows and be missed.
    const rules = compile(
      "rule long { strings: $a = /a[^>]{0,9000}=/ condition: $a }",
    );
    const reported = (span: number): boolean =>
      rules.scan(Buffer.from(`a${" ".repeat(span - 2)}=`)).length > 0;

    expect(reported(YARA_MAX_MATCH_BYTES)).toBe(true);
    expect(reported(YARA_MAX_MATCH_BYTES + 1)).toBe(false);
  });
});

describe("createArchiveContentScanner", () => {
  test("windowed inspection reaches the same rules as scanning each entry whole", async () => {
    await assertProperty(
      "windowed inspection reaches the same rules as scanning each entry whole",
      fc.asyncProperty(
        fc.record({
          entries: fc.array(entryArbitrary, { minLength: 1, maxLength: 4 }),
          step: fc.integer({ min: 32, max: 512 }),
          compression: fc.constantFrom<Compression>("STORE", "DEFLATE"),
        }),
        async ({ entries, step, compression }) => {
          const named = uniqueNames(entries);
          const matches = await scanArchive(
            await zipOf(named, compression),
            budgetWithStep(step),
          );

          expect(rulesOf(matches)).toEqual(await wholeArchiveRules(named));
          expect(
            matches.filter(({ rule }) => ARCHIVE_REFUSAL_RULES.includes(rule)),
          ).toEqual([]);
        },
      ),
      { numRuns: 60 },
    );
  });

  test.each([
    [
      "a multi-string rule",
      "<w:instrText>DDEAUTO c</w:instrText>",
      "ooxml_dde",
    ],
    ["a counting rule", RELATIONSHIP, "ooxml_external_relationship"],
    ["a long match", `<svg onload${" ".repeat(4000)}=`, "svg_event_handler"],
  ])(
    "finds %s placed across every window boundary offset",
    async (_kind, marker, rule) => {
      const window = OVERLAP + STEP;
      // Window boundaries repeat every STEP bytes, so STEP + 1 consecutive
      // start offsets place the marker at every alignment against them.
      const first = window - marker.length - 2;
      for (let at = first; at <= first + STEP; at++) {
        const content = Buffer.from(
          `${"x".repeat(at)}${marker}${"y".repeat(window)}`,
        );
        const matches = await scanArchive(
          await zipOf([{ name: "word/document.xml", content }]),
          budgetWithStep(STEP),
        );

        expect({ at, rules: rulesOf(matches) }).toEqual({ at, rules: [rule] });
      }
    },
  );

  test("counts each occurrence once although windows overlap", async () => {
    // Equal counts must not fire the counting rule, wherever windows fall.
    const content = Buffer.from(
      `${HYPERLINK}${"x".repeat(OVERLAP - 100)}${HYPERLINK}`,
    );
    const matches = await scanArchive(
      await zipOf([{ name: "word/_rels/document.xml.rels", content }]),
      budgetWithStep(STEP),
    );

    expect(matches).toEqual([]);
  });

  test("combines strings from different entries", async () => {
    const matches = await scanArchive(
      await zipOf([
        { name: "word/header1.xml", content: Buffer.from("<w:instrText>") },
        { name: "word/document.xml", content: Buffer.from("DDEAUTO c") },
      ]),
      budgetWithStep(STEP),
    );

    expect(rulesOf(matches)).toEqual(["ooxml_dde"]);
  });
});

const CENTRAL_FILE_HEADER = 0x02_01_4b_50;

const centralHeaderAt = (view: DataView, nth: number): number => {
  let found = -1;
  for (let at = 0; at + 4 <= view.byteLength; at++) {
    if (view.getUint32(at, true) === CENTRAL_FILE_HEADER) {
      found += 1;
      if (found === nth) {
        return at;
      }
    }
  }
  throw new Error("central header not found");
};

/** First entry's data offset, read from its local header. */
const firstDataAt = (view: DataView): number =>
  30 + view.getUint16(26, true) + view.getUint16(28, true);

// A name without a folder: JSZip would otherwise write a "word/" folder
// entry first, and the header patches below would land on it.
const ONE_ENTRY: readonly Entry[] = [
  { name: "document.xml", content: Buffer.from("x".repeat(2048)) },
];

const patched = async (
  edit: (view: DataView, bytes: Uint8Array) => void,
  entries: readonly Entry[] = ONE_ENTRY,
): Promise<Uint8Array> => {
  const bytes = await zipOf(entries);
  edit(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes);
  return bytes;
};

describe("archives that cannot be inspected", () => {
  test.each([
    [
      "an encrypted entry",
      "archive-encrypted",
      async () =>
        await patched((view) => {
          for (const flagsAt of [6, centralHeaderAt(view, 0) + 8]) {
            // oxlint-disable-next-line no-bitwise -- ZIP flag bit
            view.setUint16(flagsAt, view.getUint16(flagsAt, true) | 1, true);
          }
        }),
    ],
    [
      "an unsupported compression method",
      "archive-compression-unsupported",
      async () =>
        await patched((view) => {
          view.setUint16(8, 12, true);
          view.setUint16(centralHeaderAt(view, 0) + 10, 12, true);
        }),
    ],
    [
      "a damaged compressed stream",
      "archive-corrupt",
      async () =>
        await patched((view, bytes) => {
          // Deflate block type 3 is reserved, so the inflater must fail.
          const at = firstDataAt(view);
          bytes.fill(0xff, at, at + 4);
        }),
    ],
    [
      "content longer than its declared size",
      "archive-corrupt",
      async () =>
        await patched((view) => {
          const at = centralHeaderAt(view, 0) + 24;
          view.setUint32(at, view.getUint32(at, true) - 1, true);
        }),
    ],
    [
      "content shorter than its declared size",
      "archive-corrupt",
      async () =>
        await patched((view) => {
          const at = centralHeaderAt(view, 0) + 24;
          view.setUint32(at, view.getUint32(at, true) + 1, true);
        }),
    ],
    [
      "two entries with the same name",
      "archive-corrupt",
      async () =>
        await patched(
          (view, bytes) => {
            // The second entry's index name "b.xml" becomes "a.xml".
            bytes[centralHeaderAt(view, 1) + 46] = 0x61;
          },
          [
            { name: "a.xml", content: Buffer.from("one") },
            { name: "b.xml", content: Buffer.from("two") },
          ],
        ),
    ],
  ])("rejects %s", async (_case, rule, build) => {
    const matches = await scanArchive(await build(), REFUSAL_BUDGET);

    expect(rulesOf(matches)).toEqual([rule]);
    expect(verdictOf(matches)).toBe("reject");
  });

  test("refuses an archive whose inspection fails and carries the error", async () => {
    const defect = new TypeError("inspection defect");
    const matches = await createArchiveContentScanner({
      rules: {
        ...yaraWindowedRules,
        occurrences: () => {
          throw defect;
        },
      },
      budget: REFUSAL_BUDGET,
      guard: permissiveGuard,
    }).scan(await zipOf(ONE_ENTRY));

    expect(rulesOf(matches)).toEqual(["archive-inspection-failed"]);
    expect(verdictOf(matches)).toBe("reject");
    // The scanner reports nothing itself; the finding hands the error on.
    expect(matches.map(mapMatchFinding).map(({ failure }) => failure)).toEqual([
      defect,
    ]);
  });

  test("rejects an archive whose inspection runs out of time", async () => {
    let clock = 0;
    const matches = await scanArchive(
      await zipOf([
        { name: "word/document.xml", content: Buffer.from("x".repeat(20_000)) },
      ]),
      { ...REFUSAL_BUDGET, timeBudgetMs: 3 },
      () => {
        clock += 1;
        return clock;
      },
    );

    expect(rulesOf(matches)).toEqual(["archive-inspection-budget"]);
    expect(verdictOf(matches)).toBe("reject");
  });

  test("rejects an archive whose rule evidence exceeds its budget", async () => {
    const content = Buffer.from(
      Array.from(
        { length: 50 },
        (_, i) =>
          `<Relationship Id="r${i}" Type="x/hyperlink" Target="t" TargetMode="External"/>`,
      ).join(""),
    );
    const matches = await scanArchive(
      await zipOf([{ name: "word/_rels/document.xml.rels", content }]),
      { ...REFUSAL_BUDGET, maxEvidenceBytes: 1024 },
    );

    expect(rulesOf(matches)).toEqual(["archive-inspection-budget"]);
    expect(verdictOf(matches)).toBe("reject");
  });

  test("never accepts an archive carrying a refusal, whatever bytes it holds", async () => {
    await assertProperty(
      "never accepts an archive carrying a refusal, whatever bytes it holds",
      fc.asyncProperty(
        fc.record({
          entries: fc.array(entryArbitrary, { minLength: 1, maxLength: 3 }),
          damage: fc.array(fc.record({ at: fc.nat(), value: fc.nat(255) }), {
            minLength: 1,
            maxLength: 8,
          }),
        }),
        async ({ entries, damage }) => {
          const bytes = await zipOf(uniqueNames(entries));
          for (const { at, value } of damage) {
            bytes[at % bytes.length] = value;
          }

          const matches = await scanArchive(bytes, REFUSAL_BUDGET);
          const refusals = matches.filter(({ rule }) =>
            ARCHIVE_REFUSAL_RULES.includes(rule),
          );
          if (refusals.length > 0) {
            expect(verdictOf(matches)).toBe("reject");
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
