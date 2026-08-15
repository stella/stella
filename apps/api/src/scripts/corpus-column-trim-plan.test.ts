import { describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { CorpusPayload } from "@/api/lib/legal-search/corpus-storage";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-storage";
import type {
  ColumnTrimArgs,
  ColumnTrimRange,
} from "@/api/scripts/corpus-column-trim-plan";
import {
  columnTrimGate,
  columnTrimPageRange,
  columnTrimRanges,
  corpusObjectState,
  parseColumnTrimArgs,
  parseColumnTrimRanges,
  planColumnTrim,
} from "@/api/scripts/corpus-column-trim-plan";

const documentAst = (blocks: DocumentAst["blocks"]): DocumentAst => ({
  version: 1,
  source: {
    system: "obcan.justice.sk",
    documentId: "trim",
    webUrl: "https://example.test/web",
    printUrl: "",
  },
  metadata: {
    caseNumber: "1T/3/2026",
    ecli: null,
    court: "Okresný súd",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

/** What a hydrated decision's Postgres columns hold. */
const storedDocument: CorpusPayload = {
  text: "Rozsudok\n\nOdôvodnenie:\n\nText.",
  sections: [{ index: 0, type: "header", title: null, text: "Rozsudok" }],
  ast: documentAst([
    {
      id: "b1",
      anchorId: "h-1",
      type: "heading",
      level: 1,
      plainText: "Rozsudok",
      inlines: [{ type: "text", text: "Rozsudok" }],
    },
  ]),
};

/** A row whose objects hold exactly what its columns hold. */
const mirrored = {
  columnPayload: storedDocument,
  contentHash: "a-row-specific-hash",
} as const;

describe("corpusObjectState", () => {
  test("a recorded key is only verified once the object is found", () => {
    expect(
      corpusObjectState({
        key: "k",
        exists: true,
        matchesColumn: "not-checked",
      }),
    ).toBe("verified");
    expect(
      corpusObjectState({
        key: "k",
        exists: false,
        matchesColumn: "not-checked",
      }),
    ).toBe("object-missing");
  });

  test("a missing key is never verified, whatever the bucket says", () => {
    expect(
      corpusObjectState({
        key: null,
        exists: true,
        matchesColumn: "not-checked",
      }),
    ).toBe("key-missing");
  });

  test("a present object holding something else is not verified", () => {
    expect(
      corpusObjectState({ key: "k", exists: true, matchesColumn: false }),
    ).toBe("content-mismatch");
    expect(
      corpusObjectState({ key: "k", exists: true, matchesColumn: true }),
    ).toBe("verified");
  });
});

describe("planColumnTrim", () => {
  test("trims only when all three objects are verified", () => {
    expect(
      planColumnTrim({
        ...mirrored,
        text: "verified",
        sections: "verified",
        ast: "verified",
      }),
    ).toEqual({ type: "trim" });
  });

  test("one unverified object blocks the trim", () => {
    for (const [text, sections, ast] of [
      ["object-missing", "verified", "verified"],
      ["verified", "object-missing", "verified"],
      ["verified", "verified", "object-missing"],
      ["verified", "key-missing", "verified"],
      ["verified", "verified", "key-missing"],
      ["key-missing", "key-missing", "key-missing"],
    ] as const) {
      expect(planColumnTrim({ ...mirrored, text, sections, ast }).type).toBe(
        "skip",
      );
    }
  });

  test("an object holding something else cannot take the document", () => {
    // Whatever the object turned out to hold — one of the constant
    // empty shapes, a row-specific empty envelope no fixed hash can
    // name, or an older version of this decision — the comparison
    // against the column is what rejects it, and the reason says so.
    for (const mismatched of ["text", "sections", "ast"] as const) {
      const decision = planColumnTrim({
        text: "verified",
        sections: "verified",
        ast: "verified",
        ...mirrored,
        [mismatched]: "content-mismatch",
      });

      expect(decision.type).toBe("skip");
      expect(decision.type === "skip" ? decision.reason : "").toContain(
        "does not hold what the columns hold",
      );
    }
  });

  test("columns holding no document trim only when the hash is a known empty", () => {
    const emptyHash = EMPTY_CORPUS_CONTENT_HASHES[0] ?? "";
    for (const columnPayload of [
      { text: null, sections: null, ast: null },
      { text: "", sections: null, ast: {} },
    ] satisfies CorpusPayload[]) {
      expect(
        planColumnTrim({
          text: "verified",
          sections: "verified",
          ast: "verified",
          columnPayload,
          contentHash: emptyHash,
        }),
      ).toEqual({ type: "trim" });
      // A missing object still blocks: nothing proves the row was ever
      // written to object storage.
      expect(
        planColumnTrim({
          text: "object-missing",
          sections: "verified",
          ast: "verified",
          columnPayload,
          contentHash: emptyHash,
        }).type,
      ).toBe("skip");
    }
    // A row-specific hash over empty columns is the verbatim empty-envelope
    // copy: trimming would strand the row for the fetch queue, which
    // recognises it by the surviving AST artifact.
    expect(
      planColumnTrim({
        text: "verified",
        sections: "verified",
        ast: "verified",
        columnPayload: { text: "", sections: [], ast: documentAst([]) },
        contentHash: "a-row-specific-hash",
      }).type,
    ).toBe("skip");
  });

  test("the skip reason names every object's state", () => {
    const decision = planColumnTrim({
      ...mirrored,
      text: "verified",
      sections: "object-missing",
      ast: "verified",
    });
    if (decision.type !== "skip") {
      throw new Error("expected a skip");
    }
    expect(decision.reason).toBe(
      "text=verified sections=object-missing ast=verified",
    );
  });
});

describe("columnTrimGate", () => {
  test("only canonical mode may trim without --force", () => {
    expect(columnTrimGate({ mode: "canonical", force: false }).type).toBe(
      "allowed",
    );
    expect(columnTrimGate({ mode: "dual-write", force: false }).type).toBe(
      "refused",
    );
    expect(columnTrimGate({ mode: "off", force: false }).type).toBe("refused");
  });

  test("--force overrides the refusal", () => {
    expect(columnTrimGate({ mode: "off", force: true }).type).toBe("allowed");
  });
});

/** Ids in ascending order, so a range built from them is well-formed. */
const ID = {
  a: "019dd0c5-f3bc-7000-84b2-cf5f7a95ce5f",
  b: "01a00247-0d3c-7000-b1b9-0301bea6441e",
  c: "01a10000-0000-7000-8000-000000000000",
  d: "01a20000-0000-7000-8000-000000000000",
} as const;

/**
 * Every field the parser sets, so a field added later cannot slip into a
 * run unasserted.
 */
const parsedArgs = (overrides: Partial<ColumnTrimArgs>): ColumnTrimArgs => ({
  limit: null,
  after: null,
  idFrom: null,
  idTo: null,
  rangesFile: null,
  dryRun: false,
  force: false,
  ...overrides,
});

describe("parseColumnTrimArgs", () => {
  test("defaults to an uncapped, mutating, gated run from the start", () => {
    expect(parseColumnTrimArgs([])).toEqual({
      type: "parsed",
      args: parsedArgs({}),
    });
  });

  test("accepts both --limit forms alongside the flags", () => {
    expect(parseColumnTrimArgs(["--limit", "25", "--dry-run"])).toEqual({
      type: "parsed",
      args: parsedArgs({ limit: 25, dryRun: true }),
    });
    expect(parseColumnTrimArgs(["--limit=25", "--force"])).toEqual({
      type: "parsed",
      args: parsedArgs({ limit: 25, force: true }),
    });
  });

  test("accepts both --after forms and requires a UUID", () => {
    expect(parseColumnTrimArgs(["--after", ID.a])).toEqual({
      type: "parsed",
      args: parsedArgs({ after: ID.a }),
    });
    expect(parseColumnTrimArgs([`--after=${ID.a}`, "--dry-run"])).toEqual({
      type: "parsed",
      args: parsedArgs({ after: ID.a, dryRun: true }),
    });
    for (const argv of [["--after"], ["--after", "not-a-uuid"]]) {
      expect(parseColumnTrimArgs(argv)).toEqual({
        type: "invalid",
        message: "--after requires a decision id (UUID)",
      });
    }
  });

  test("accepts both forms of every id bound", () => {
    expect(parseColumnTrimArgs(["--id-from", ID.a, "--id-to", ID.c])).toEqual({
      type: "parsed",
      args: parsedArgs({ idFrom: ID.a, idTo: ID.c }),
    });
    expect(
      parseColumnTrimArgs([`--id-from=${ID.a}`, `--id-to=${ID.c}`]),
    ).toEqual({
      type: "parsed",
      args: parsedArgs({ idFrom: ID.a, idTo: ID.c }),
    });
    for (const flag of ["--id-from", "--id-to"]) {
      expect(parseColumnTrimArgs([flag, "not-a-uuid"])).toEqual({
        type: "invalid",
        message: `${flag} requires a decision id (UUID)`,
      });
    }
  });

  test("takes a --ranges-file path, and refuses an empty one", () => {
    expect(parseColumnTrimArgs(["--ranges-file", "./ranges.json"])).toEqual({
      type: "parsed",
      args: parsedArgs({ rangesFile: "./ranges.json" }),
    });
    expect(parseColumnTrimArgs(["--ranges-file"]).type).toBe("invalid");
  });

  /**
   * A run that silently walked something other than what was asked for
   * would report coverage it does not have, so contradictory bounds are
   * refused rather than resolved by precedence.
   */
  test("refuses bounds that contradict each other or span nothing", () => {
    for (const argv of [
      ["--ranges-file", "./r.json", "--after", ID.a],
      ["--ranges-file", "./r.json", "--id-from", ID.a],
      ["--ranges-file", "./r.json", "--id-to", ID.c],
      ["--after", ID.a, "--id-from", ID.b],
      ["--id-from", ID.c, "--id-to", ID.a],
      ["--after", ID.c, "--id-to", ID.a],
      ["--id-from", ID.a, "--id-to", ID.a],
    ]) {
      expect(parseColumnTrimArgs(argv).type).toBe("invalid");
    }
  });

  test("rejects a non-positive, non-numeric, or absent limit", () => {
    for (const argv of [
      ["--limit"],
      ["--limit", "0"],
      ["--limit", "-3"],
      ["--limit", "abc"],
      ["--limit", "--dry-run"],
    ]) {
      expect(parseColumnTrimArgs(argv).type).toBe("invalid");
    }
  });

  test("rejects an unknown flag instead of ignoring it", () => {
    expect(parseColumnTrimArgs(["--wipe"]).type).toBe("invalid");
  });
});

describe("parseColumnTrimRanges", () => {
  test("keeps a sorted, disjoint file as written", () => {
    expect(
      parseColumnTrimRanges(
        JSON.stringify([
          { from: ID.a, to: ID.b },
          { from: ID.c, to: ID.d },
        ]),
      ),
    ).toEqual({
      type: "parsed",
      ranges: [
        { from: ID.a, to: ID.b },
        { from: ID.c, to: ID.d },
      ],
    });
  });

  test("a single-id range is a range", () => {
    expect(
      parseColumnTrimRanges(JSON.stringify([{ from: ID.a, to: ID.a }])),
    ).toEqual({ type: "parsed", ranges: [{ from: ID.a, to: ID.a }] });
  });

  /**
   * Every refusal below would otherwise produce a run whose printed
   * coverage does not describe what it walked: a double-counted span, a
   * gap the operator believes is covered, or an id the database would
   * order differently than the file does.
   */
  test("refuses malformed, unsorted or overlapping ranges", () => {
    for (const raw of [
      "not json",
      JSON.stringify({ from: ID.a, to: ID.b }),
      JSON.stringify([]),
      JSON.stringify([ID.a]),
      JSON.stringify([{ from: ID.a }]),
      JSON.stringify([{ from: ID.a, to: "not-a-uuid" }]),
      // Uppercase would compare differently as text than the database
      // orders it as a uuid.
      JSON.stringify([{ from: ID.a.toUpperCase(), to: ID.b }]),
      JSON.stringify([{ from: ID.b, to: ID.a }]),
      JSON.stringify([
        { from: ID.c, to: ID.d },
        { from: ID.a, to: ID.b },
      ]),
      JSON.stringify([
        { from: ID.a, to: ID.c },
        { from: ID.b, to: ID.d },
      ]),
      // Touching at one id still double-trims that row.
      JSON.stringify([
        { from: ID.a, to: ID.b },
        { from: ID.b, to: ID.c },
      ]),
    ]) {
      expect(parseColumnTrimRanges(raw).type).toBe("invalid");
    }
  });
});

describe("columnTrimRanges", () => {
  test("a bare run walks the whole id space", () => {
    expect(
      columnTrimRanges({ args: parsedArgs({}), fileRanges: null }),
    ).toEqual([{ lower: { type: "unbounded" }, upper: null }]);
  });

  test("--after resumes exclusively, --id-from starts inclusively", () => {
    expect(
      columnTrimRanges({ args: parsedArgs({ after: ID.a }), fileRanges: null }),
    ).toEqual([{ lower: { type: "after", id: ID.a }, upper: null }]);
    expect(
      columnTrimRanges({
        args: parsedArgs({ idFrom: ID.a }),
        fileRanges: null,
      }),
    ).toEqual([{ lower: { type: "at-or-after", id: ID.a }, upper: null }]);
  });

  test("--id-to bounds a resumed walk as well as a fresh one", () => {
    expect(
      columnTrimRanges({
        args: parsedArgs({ after: ID.a, idTo: ID.c }),
        fileRanges: null,
      }),
    ).toEqual([{ lower: { type: "after", id: ID.a }, upper: ID.c }]);
  });

  test("a ranges file becomes one inclusive range per entry, in order", () => {
    expect(
      columnTrimRanges({
        args: parsedArgs({ rangesFile: "./r.json" }),
        fileRanges: [
          { from: ID.a, to: ID.b },
          { from: ID.c, to: ID.d },
        ],
      }),
    ).toEqual([
      { lower: { type: "at-or-after", id: ID.a }, upper: ID.b },
      { lower: { type: "at-or-after", id: ID.c }, upper: ID.d },
    ]);
  });
});

describe("columnTrimPageRange", () => {
  const range = {
    lower: { type: "at-or-after", id: ID.a },
    upper: ID.d,
  } as const satisfies ColumnTrimRange;

  test("the first page is the range itself", () => {
    expect(columnTrimPageRange({ range, cursor: null })).toEqual(range);
  });

  /**
   * The upper bound has to survive pagination: a later page that dropped
   * it would scan past the range and reintroduce the unbounded scan the
   * bound exists to prevent.
   */
  test("later pages resume after the cursor and keep the upper bound", () => {
    expect(columnTrimPageRange({ range, cursor: ID.b })).toEqual({
      lower: { type: "after", id: ID.b },
      upper: ID.d,
    });
    expect(
      columnTrimPageRange({
        range: { lower: { type: "unbounded" }, upper: null },
        cursor: ID.b,
      }),
    ).toEqual({ lower: { type: "after", id: ID.b }, upper: null });
  });
});
