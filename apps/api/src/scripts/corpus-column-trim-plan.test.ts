import { describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { CorpusPayload } from "@/api/handlers/case-law/corpus-storage";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/handlers/case-law/corpus-storage";
import {
  columnTrimGate,
  corpusObjectState,
  parseColumnTrimArgs,
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

describe("parseColumnTrimArgs", () => {
  test("defaults to an uncapped, mutating, gated run", () => {
    expect(parseColumnTrimArgs([])).toEqual({
      type: "parsed",
      args: { limit: null, dryRun: false, force: false },
    });
  });

  test("accepts both --limit forms alongside the flags", () => {
    expect(parseColumnTrimArgs(["--limit", "25", "--dry-run"])).toEqual({
      type: "parsed",
      args: { limit: 25, dryRun: true, force: false },
    });
    expect(parseColumnTrimArgs(["--limit=25", "--force"])).toEqual({
      type: "parsed",
      args: { limit: 25, dryRun: false, force: true },
    });
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
