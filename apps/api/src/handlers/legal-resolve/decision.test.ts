import { panic, Result } from "better-result";
import { describe, expect, expectTypeOf, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { legalResolveResponseSchema } from "@stll/api-contract/legal-resolve";
import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import {
  type DecisionIdentityRow,
  docketFamilyCitationKeys,
  type lookupDecisionsByIdentity,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import { ecjCaseNumber } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { bareCitationKey } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  admitLawRead,
  type LawReadAdmission,
} from "@/api/handlers/legal-resolve/admission";
import { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import { createSafeId } from "@/api/lib/branded-types";
import { buildCaseLawDecisionUrl } from "@/api/lib/legal-search/public-law-app-urls";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import { MCP_CONTENT_MAX_CHARS, toPlainCorpusText } from "@/api/mcp/tool-utils";

const organizationId =
  parseAuthProviderId<"organization">("organization") ??
  panic("Fixture organization id is invalid");
const admissionResult = admitLawRead({
  organizationId,
  publicLawEnabled: () => true,
});
const admission = Result.isOk(admissionResult)
  ? admissionResult.value
  : panic("Fixture law read was not admitted");

test("requires a law-read admission at compile time", () => {
  type Options = Parameters<typeof resolveDecision>[0];
  expectTypeOf<Options["admission"]>().toEqualTypeOf<LawReadAdmission>();
  expectTypeOf<{
    country: string;
    identifier: string;
  }>().not.toExtend<Options>();
});

const row = (caseNumber = "3 Afs 41/2008 - 98") =>
  ({
    id: createSafeId<"caseLawDecision">(),
    caseNumber,
    caseNumberType: "case-number",
    country: "CZE",
    court: "Nejvyšší správní soud",
    courtAbbreviation: "NSS",
    decisionDate: "2008-10-30",
    decisionType: "rozsudek",
    ecli: "ECLI:CZ:NSS:2008:3.AFS.41.2008.98",
    identifiers: [],
    language: "cs",
    languageAlternates: [],
    slug: "/case/example",
  }) satisfies DecisionIdentityRow;

const lookupRows = (rows: DecisionIdentityRow[]) => async () => rows;

const decisionAst = (texts = ["Text"], numbered = false) =>
  ({
    version: 1,
    source: {
      system: "legal-resolve-test",
      documentId: "decision",
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber: "3 Afs 41/2008 - 98",
      ecli: "ECLI:CZ:NSS:2008:3.AFS.41.2008.98",
      court: "Nejvyšší správní soud",
      decisionDate: "2008-10-30",
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: texts.map((text, index) => ({
      type: "paragraph",
      id: `paragraph-${String(index + 1)}`,
      anchorId: `paragraph-${String(index + 1)}`,
      plainText: text,
      inlines: [{ type: "text", text }],
      ...(numbered ? { number: index + 1 } : {}),
    })),
  }) satisfies DocumentAst;

const readableDecision: typeof readDecisionReaderSource = async () => ({
  status: "read",
  decision: {
    id: row().id,
    caseNumber: row().caseNumber,
    caseNumberType: row().caseNumberType,
    courtAbbreviation: row().courtAbbreviation,
    courtTier: "supreme",
    court: row().court,
    country: row().country,
    decisionDate: row().decisionDate,
    ecli: row().ecli,
    language: row().language,
    languageAlternates: row().languageAlternates,
    slug: row().slug,
  },
  textAccess: "readable",
  ast: decisionAst(),
  citationAnchors: [],
  provisionAnchors: [],
  provisionStatus: null,
  referenceNextCursor: null,
});

const readableDecisionWith =
  (ast: DocumentAst): typeof readDecisionReaderSource =>
  async () => {
    const base = await readableDecision({
      decisionId: row().id,
      phase: "blocks",
      audience: "model",
      surface: "search",
    });
    if (base?.status !== "read") {
      return panic("Fixture decision is not readable");
    }
    return { ...base, ast };
  };

const readableResult = (
  result: Awaited<ReturnType<typeof resolveDecision>>,
  source: DocumentAst,
) => {
  if (
    result.status !== "resolved" ||
    result.document.kind !== "decision" ||
    result.document.text.status !== "readable"
  ) {
    return panic("Expected readable decision fixture");
  }
  const ast = parseCaseLawDecisionAst({
    ...source,
    blocks: result.document.text.blocks,
  });
  if (ast === null) {
    return panic("Resolved decision blocks are not a case-law AST");
  }
  return { ast, text: result.document.text };
};

const missingDecision: typeof readDecisionReaderSource = async () => null;

const licensedDecision: typeof readDecisionReaderSource = async () => {
  const readable = await readableDecision({
    decisionId: row().id,
    phase: "blocks",
    audience: "model",
    surface: "search",
  });
  if (readable?.status !== "read") {
    return panic("Fixture decision is not readable");
  }
  return { ...readable, textAccess: "withheld", ast: null };
};

describe("decision legal resolution", () => {
  test("returns every non-resolved envelope status", async () => {
    expect(
      await resolveDecision({ admission, country: "CZE", identifier: "   " }),
    ).toEqual({
      status: "incomplete_identifier",
      missing: ["identifier"],
    });
    expect(
      await resolveDecision({
        admission,
        country: "FRA",
        identifier: "ECLI:FR:CCASS:2024:1",
      }),
    ).toEqual({
      status: "country_unavailable",
    });
    // A code that names no country answers like the law route does.
    expect(
      await resolveDecision({
        admission,
        country: "XX",
        identifier: "3 Afs 41/2008 - 98",
      }),
    ).toEqual({
      status: "country_unavailable",
    });
    expect(
      await resolveDecision({
        admission,
        country: "CZE",
        identifier: "ECLI:CZ:NSS:2008:3.AFS.41.2008.98",
        dependencies: { lookup: lookupRows([]) },
      }),
    ).toEqual({ status: "not_found", reason: "no_exact_identity" });
    expect(
      await resolveDecision({
        admission,
        country: "CZE",
        identifier: "3 Afs 41/2008 - 98",
        dependencies: { lookup: lookupRows([row(), row()]) },
      }),
    ).toMatchObject({
      status: "ambiguous",
      candidates: [
        { decisionId: expect.any(String), readerUrl: expect.any(String) },
        { decisionId: expect.any(String), readerUrl: expect.any(String) },
      ],
    });
  });

  test("returns readable blocks for an exact identity", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZE",
      identifier: "3 Afs 41/2008 - 98",
      dependencies: { lookup: lookupRows([row()]), read: readableDecision },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: {
        kind: "decision",
        decisionId: expect.any(String),
        text: {
          status: "readable",
          blocks: decisionAst().blocks,
          extent: { type: "complete" },
        },
      },
    });
    if (result.status === "resolved" && result.document.kind === "decision") {
      expect(result.document.readerUrl).toBe(
        buildCaseLawDecisionUrl({
          caseNumber: row().caseNumber,
          country: row().country,
          court: row().court,
          decisionId: result.document.decisionId,
          language: row().language,
          languageAlternates: row().languageAlternates,
          slug: row().slug,
        }),
      );
    }
  });

  test("bounds large decisions at whole blocks", async () => {
    const ast = decisionAst([
      "a".repeat(MCP_CONTENT_MAX_CHARS - 2),
      "second block",
    ]);
    const result = await resolveDecision({
      admission,
      country: "CZE",
      identifier: "3 Afs 41/2008 - 98",
      dependencies: {
        lookup: lookupRows([row()]),
        read: readableDecisionWith(ast),
      },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: {
        kind: "decision",
        decisionId: expect.any(String),
        readerUrl: expect.any(String),
        text: {
          status: "readable",
          blocks: [ast.blocks.at(0)],
          extent: {
            type: "partial",
            returnedChars: MCP_CONTENT_MAX_CHARS - 2,
            totalChars: MCP_CONTENT_MAX_CHARS + "second block".length,
          },
        },
      },
    });
  });

  test("cuts an oversized first block without splitting a surrogate pair", async () => {
    const text = `${"a".repeat(MCP_CONTENT_MAX_CHARS - 1)}😀tail`;
    const result = await resolveDecision({
      admission,
      country: "CZE",
      identifier: "3 Afs 41/2008 - 98",
      dependencies: {
        lookup: lookupRows([row()]),
        read: readableDecisionWith(decisionAst([text])),
      },
    });
    const readable = readableResult(result, decisionAst([text]));
    const returned = readable.ast.blocks.at(0);
    expect(returned?.plainText).toBe("a".repeat(MCP_CONTENT_MAX_CHARS - 1));
    expect(returned?.plainText.length).toBeGreaterThan(0);
    expect(readable.text.extent).toEqual({
      type: "partial",
      returnedChars: MCP_CONTENT_MAX_CHARS - 1,
      totalChars: text.length,
    });
  });

  test("legal-resolve.decision-readable-extent-bound", async () => {
    await assertProperty(
      "legal-resolve.decision-readable-extent-bound",
      fc.asyncProperty(
        fc.array(
          fc.string({ minLength: 1, maxLength: MCP_CONTENT_MAX_CHARS + 20 }),
          { minLength: 1, maxLength: 4 },
        ),
        // Court-numbered paragraphs are served with their number, which the
        // extent has to count like the text does.
        fc.boolean(),
        async (texts, numbered) => {
          const source = decisionAst(texts, numbered);
          const fullBlocks = parseCaseLawDecisionAst(source)?.blocks ?? [];
          const totalChars =
            toPlainCorpusText({ blocks: fullBlocks, fulltext: null })?.length ??
            0;
          const result = await resolveDecision({
            admission,
            country: "CZE",
            identifier: "3 Afs 41/2008 - 98",
            dependencies: {
              lookup: lookupRows([row()]),
              read: readableDecisionWith(source),
            },
          });
          const readable = readableResult(result, source);
          const returnedChars =
            toPlainCorpusText({
              blocks: readable.ast.blocks,
              fulltext: null,
            })?.length ?? 0;
          expect(returnedChars).toBeLessThanOrEqual(MCP_CONTENT_MAX_CHARS);
          switch (readable.text.extent.type) {
            case "complete":
              expect(returnedChars).toBe(totalChars);
              break;
            case "partial":
              expect(readable.text.extent.returnedChars).toBe(returnedChars);
              expect(readable.text.extent.totalChars).toBe(totalChars);
              break;
            default:
              readable.text.extent satisfies never;
          }
        },
      ),
    );
  });

  test("marks only licensed text as withheld", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZE",
      identifier: "3 Afs 41/2008 - 98",
      dependencies: { lookup: lookupRows([row()]), read: licensedDecision },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: {
        kind: "decision",
        court: expect.any(String),
        text: { status: "withheld", reason: "licence" },
      },
    });
  });

  test("finds the one decision a bare docket matches, even in a file that can hold more", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZE",
      identifier: "3 Afs 41/2008",
      dependencies: { lookup: lookupRows([row()]), read: readableDecision },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: { kind: "decision", caseNumber: "3 Afs 41/2008 - 98" },
    });
  });

  test("finds the one decision whose file matches when its sheet is not recorded", async () => {
    const unsheeted = { ...row("3 Afs 41/2008"), ecli: null };
    const result = await resolveDecision({
      admission,
      country: "CZE",
      identifier: "3 Afs 41/2008 - 98",
      dependencies: { lookup: lookupRows([unsheeted]), read: readableDecision },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: { kind: "decision", decisionId: unsheeted.id },
    });
  });

  test("leaves the same docket at two courts ambiguous, listing both", async () => {
    const brno = {
      ...row("22 Ad 11/2023"),
      court: "Krajský soud v Brně",
      courtAbbreviation: "KSBR",
      ecli: null,
    };
    const ostrava = {
      ...row("22 Ad 11/2023"),
      court: "Krajský soud v Ostravě",
      courtAbbreviation: "KSOS",
      ecli: null,
    };
    expect(
      await resolveDecision({
        admission,
        country: "CZE",
        identifier: "22 Ad 11/2023",
        dependencies: { lookup: lookupRows([brno, ostrava]) },
      }),
    ).toMatchObject({
      status: "ambiguous",
      candidates: [
        { decisionId: brno.id, label: expect.stringContaining("Brně") },
        { decisionId: ostrava.id, label: expect.stringContaining("Ostravě") },
      ],
    });
  });

  test("tells a judgment from the opinion on the same docket", async () => {
    // One CJEU docket holds both, from the same court; before the kind was
    // in the label the two candidates differed only by date.
    const eu = {
      ...row("C-144/04"),
      country: "EU",
      court: "Court of Justice",
      courtAbbreviation: null,
      language: "en",
    };
    const opinion = {
      ...eu,
      id: createSafeId<"caseLawDecision">(),
      decisionDate: "2005-06-30",
      decisionType: "opinion",
      ecli: "ECLI:EU:C:2005:420",
    };
    const judgment = {
      ...eu,
      decisionDate: "2005-11-22",
      decisionType: "judgment",
      ecli: "ECLI:EU:C:2005:709",
    };
    expect(
      await resolveDecision({
        admission,
        country: "EU",
        identifier: "C-144/04",
        dependencies: { lookup: lookupRows([opinion, judgment]) },
      }),
    ).toMatchObject({
      status: "ambiguous",
      candidates: [
        {
          decisionId: opinion.id,
          label: "Court of Justice, opinion, 2005-06-30",
        },
        {
          decisionId: judgment.id,
          label: "Court of Justice, judgment, 2005-11-22",
        },
      ],
    });
  });

  test("resolves a Court of Justice case by the docket its adapter stores", async () => {
    // Before 1989 the Court numbered cases without a letter; the adapter
    // stores the docket as the publisher states it, and a reader copies it.
    for (const [celex, statement] of [
      ["61978CJ0120", "Case 120/78."],
      ["61955CJ0008", "Case 8-55."],
      ["62022CJ0128", "Case C-128/22"],
    ] as const) {
      const caseNumber = ecjCaseNumber(celex, [statement]);
      const stored = {
        ...row(caseNumber),
        country: "EU",
        court: "Court of Justice",
        courtAbbreviation: null,
        ecli: null,
        language: "en",
      };
      // The read side of the stored row: the key ingestion writes for its
      // docket is one the reference's family is looked up under.
      const lookup: typeof lookupDecisionsByIdentity = async ({ locator }) =>
        locator.kind === "docket" &&
        docketFamilyCitationKeys(locator).includes(bareCitationKey(caseNumber))
          ? [stored]
          : [];
      const result = await resolveDecision({
        admission,
        country: "EU",
        identifier: caseNumber,
        dependencies: { lookup, read: readableDecision },
      });
      expect([caseNumber, result.status]).toEqual([caseNumber, "resolved"]);
    }
    expect(ecjCaseNumber("61978CJ0120", ["Case 120/78."])).toBe("120/78");
  });

  test("never resolves a printed part to the one decision of its file", async () => {
    // A part selector leaves the whole file open, so a lone candidate may be
    // a sibling under another part.
    const bare = { ...row("3 Afs 41/2008"), ecli: null };
    expect(
      await resolveDecision({
        admission,
        country: "CZE",
        identifier: "3 Afs 41/2008 - II.",
        dependencies: { lookup: lookupRows([bare]), read: readableDecision },
      }),
    ).toEqual({ status: "not_found", reason: "no_exact_identity" });
  });

  test("never picks one of several unrecorded sheets for a printed sheet", async () => {
    const first = { ...row("3 Afs 41/2008"), ecli: null };
    const second = { ...row("3 Afs 41/2008"), ecli: null };
    expect(
      await resolveDecision({
        admission,
        country: "CZE",
        identifier: "3 Afs 41/2008 - 98",
        dependencies: { lookup: lookupRows([first, second]) },
      }),
    ).toEqual({ status: "not_found", reason: "no_exact_identity" });
  });

  test("marks a missing read as unavailable, not licensed", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZE",
      identifier: "3 Afs 41/2008 - 98",
      dependencies: { lookup: lookupRows([row()]), read: missingDecision },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: { kind: "decision", text: { status: "unavailable" } },
    });
  });

  test("marks a readable decision without a body as unavailable", async () => {
    const bodyless: typeof readDecisionReaderSource = async () => {
      const readable = await readableDecision({
        decisionId: row().id,
        phase: "blocks",
        audience: "model",
        surface: "search",
      });
      if (readable?.status !== "read") {
        return panic("Fixture decision is not readable");
      }
      return { ...readable, ast: null };
    };
    for (const read of [bodyless, readableDecisionWith(decisionAst([]))]) {
      const result = await resolveDecision({
        admission,
        country: "CZE",
        identifier: "3 Afs 41/2008 - 98",
        dependencies: { lookup: lookupRows([row()]), read },
      });
      expect(result).toMatchObject({
        status: "resolved",
        document: { kind: "decision", text: { status: "unavailable" } },
      });
    }
  });

  test("never promotes docket prefixes or near misses to candidates", async () => {
    for (const identifier of ["3 Afs 41", "3 Afs 41/2008 - 99"]) {
      expect(
        await resolveDecision({
          admission,
          country: "CZE",
          identifier,
          dependencies: { lookup: lookupRows([row()]) },
        }),
      ).toEqual({ status: "not_found", reason: "no_exact_identity" });
    }
  });

  test("resolves an EU judgment by ECLI with its language alternates", async () => {
    const judgment = {
      ...row("C-40/17"),
      country: "EU",
      language: "en",
      ecli: "ECLI:EU:C:2019:801",
      languageAlternates: [
        { ...row("C-40/17"), id: "judgment-en", language: "en" },
        { ...row("C-40/17"), id: "judgment-fr", language: "fr" },
        { ...row("C-40/17"), id: "judgment-de", language: "de" },
      ],
    } satisfies DecisionIdentityRow;
    const result = await resolveDecision({
      admission,
      country: "EU",
      identifier: "ECLI:EU:C:2019:801",
      dependencies: {
        lookup: async () => [judgment],
        read: readableDecision,
      },
    });

    expect(result).toMatchObject({
      status: "resolved",
      document: {
        kind: "decision",
        country: "EU",
        language: "en",
        languageAlternates: [
          { decisionId: "judgment-en", language: "en" },
          { decisionId: "judgment-fr", language: "fr" },
          { decisionId: "judgment-de", language: "de" },
        ],
      },
    });
  });
});

// Public dockets: KS České Budějovice 65 A 3/2025-226 (21 May 2025),
// KS Ostrava – Olomouc 65 A 3/2025-63 (28 May 2025).
// https://msp.gov.cz/documents/d/krajsky-soud-v-ceskych-budejovicich/65a_3_2025-150
const regionalRow = (
  court: string,
  sheetNumber: string,
): DecisionIdentityRow => ({
  ...row("65 A 3/2025"),
  court,
  courtAbbreviation: "KS",
  ecli: null,
  sheetNumber,
  decisionDate:
    court === "Krajský soud v Českých Budějovicích"
      ? "2025-05-21"
      : "2025-05-28",
  subjectSummary: "Stavební zákon",
});
const regionalHolders = () => [
  regionalRow("Krajský soud v Českých Budějovicích", "226"),
  regionalRow("Krajský soud v Ostravě – pobočka v Olomouci", "63"),
];

describe("a docket at other courts", () => {
  test("a named court with no holder never resolves another court's decision", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZ",
      identifier: "KS Praha 65 A 3/2025-133",
      dependencies: {
        lookup: lookupRows(regionalHolders()),
        read: async () => panic("Wrong-court result must not fetch text"),
      },
    });
    expect(v.safeParse(legalResolveResponseSchema, result).success).toBe(true);
    expect(result).toMatchObject({
      status: "not_found",
      reason: "not_at_this_court",
      otherCourtCandidates: [
        {
          court: "Krajský soud v Českých Budějovicích",
          decisionDate: "2025-05-21",
          decisionType: "rozsudek",
          subjectSummary: "Stavební zákon",
        },
        {
          court: "Krajský soud v Ostravě – pobočka v Olomouci",
          decisionDate: "2025-05-28",
          decisionType: "rozsudek",
          subjectSummary: "Stavební zákon",
        },
      ],
    });
  });
  test.each([
    "Krajský soud v Českých Budějovicích 65 A 3/2025",
    "rozsudek Krajského soudu v Českých Budějovicích 65 A 3/2025",
    "KS České Budějovice 65  A  3 / 2025 - 226",
  ])(
    "the named court resolves and exposes other docket holders: %s",
    async (identifier) => {
      const result = await resolveDecision({
        admission,
        country: "CZ",
        identifier,
        dependencies: {
          lookup: lookupRows(regionalHolders()),
          read: readableDecision,
        },
      });
      expect(v.safeParse(legalResolveResponseSchema, result).success).toBe(
        true,
      );
      expect(result).toMatchObject({
        status: "resolved",
        document: { court: "Krajský soud v Českých Budějovicích" },
        otherCourtCandidates: [
          { court: "Krajský soud v Ostravě – pobočka v Olomouci" },
        ],
      });
      if (result.status !== "resolved") {
        panic("Expected named-court decision");
      }
      expect(result.otherCourtCandidates).toHaveLength(1);
    },
  );
  test("a named sheet discovers holders stored under other sheets through the docket family", async () => {
    const [selected, other] = regionalHolders();
    if (selected === undefined || other === undefined) {
      panic("Missing regional fixture");
    }
    const result = await resolveDecision({
      admission,
      country: "CZ",
      identifier: "KS České Budějovice 65 A 3/2025-226",
      dependencies: {
        lookup: async ({ locator }) =>
          locator.kind === "docket" && locator.selector.kind === "none"
            ? [selected, other]
            : [selected],
        read: readableDecision,
      },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: { court: "Krajský soud v Českých Budějovicích" },
      otherCourtCandidates: [
        { court: "Krajský soud v Ostravě – pobočka v Olomouci" },
      ],
    });
  });
  test("lists other holders by court in the docket's language, then date, undated last", async () => {
    const [budejovice, olomouc] = regionalHolders();
    if (budejovice === undefined || olomouc === undefined) {
      panic("Missing regional fixture");
    }
    const undated: DecisionIdentityRow = {
      ...budejovice,
      id: createSafeId<"caseLawDecision">(),
      sheetNumber: "301",
      decisionDate: null,
    };
    const result = await resolveDecision({
      admission,
      country: "CZ",
      identifier: "KS Praha 65 A 3/2025",
      dependencies: {
        lookup: lookupRows([olomouc, undated, budejovice]),
        read: async () => panic("Wrong-court result must not fetch text"),
      },
    });
    if (result.status !== "not_found") {
      panic("Expected a wrong-court answer");
    }
    expect(
      result.otherCourtCandidates?.map(({ court, decisionDate }) => [
        court,
        decisionDate,
      ]),
    ).toEqual([
      ["Krajský soud v Českých Budějovicích", "2025-05-21"],
      ["Krajský soud v Českých Budějovicích", null],
      ["Krajský soud v Ostravě – pobočka v Olomouci", "2025-05-28"],
    ]);
  });
  test.each([
    "Okresní soud v Kolíně 65 A 3/2025",
    "rozsudek Okresního soudu v Kolíně 65 A 3/2025-12",
    "OS Kolín 65 A 3/2025",
  ])(
    "a named court the corpus does not know never resolves another court's holder: %s",
    async (identifier) => {
      const [budejovice] = regionalHolders();
      if (budejovice === undefined) {
        panic("Missing regional fixture");
      }
      const result = await resolveDecision({
        admission,
        country: "CZ",
        identifier,
        dependencies: {
          lookup: lookupRows([budejovice]),
          read: async () => panic("An unknown court must not fetch text"),
        },
      });
      expect(v.safeParse(legalResolveResponseSchema, result).success).toBe(
        true,
      );
      expect(result).toMatchObject({
        status: "not_found",
        reason: "court_unrecognized",
        otherCourtCandidates: [
          { court: "Krajský soud v Českých Budějovicích" },
        ],
      });
    },
  );
  test("words that name no court leave the docket unconstrained", async () => {
    const [budejovice] = regionalHolders();
    if (budejovice === undefined) {
      panic("Missing regional fixture");
    }
    const result = await resolveDecision({
      admission,
      country: "CZ",
      identifier: "rozsudek 65 A 3/2025",
      dependencies: {
        lookup: lookupRows([budejovice]),
        read: readableDecision,
      },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: { court: "Krajský soud v Českých Budějovicích" },
    });
  });
  test("no court leaves a shared docket ambiguous", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZ",
      identifier: "65 A 3/2025",
      dependencies: { lookup: lookupRows(regionalHolders()) },
    });
    expect(result).toMatchObject({ status: "ambiguous" });
    expect(result).not.toHaveProperty("otherCourtCandidates");
  });
  test("an exact hit with no other holders carries no candidates noise", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZ",
      identifier: "NSS 3 Afs 41/2008-98",
      dependencies: { lookup: lookupRows([row()]), read: readableDecision },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: { court: "Nejvyšší správní soud" },
    });
    expect(result).not.toHaveProperty("otherCourtCandidates");
  });
  test("one regional holder at the named court carries no candidates noise", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZ",
      identifier: "KS České Budějovice 65 A 3/2025-226",
      dependencies: {
        lookup: lookupRows(regionalHolders().slice(0, 1)),
        read: readableDecision,
      },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: { court: "Krajský soud v Českých Budějovicích" },
    });
    expect(result).not.toHaveProperty("otherCourtCandidates");
  });
  test("a Slovak court name constrains its own docket grammar", async () => {
    const result = await resolveDecision({
      admission,
      country: "SK",
      identifier: "Krajský súd v Bratislave 1S/1/2020",
      dependencies: {
        lookup: lookupRows([
          {
            ...regionalRow("Krajský súd v Košiciach", "133"),
            caseNumber: "1S/1/2020",
            country: "SVK",
          },
        ]),
        read: async () => panic("Wrong-court result must not fetch text"),
      },
    });
    expect(result).toMatchObject({
      status: "not_found",
      reason: "not_at_this_court",
      otherCourtCandidates: [{ court: "Krajský súd v Košiciach" }],
    });
  });
  test("As and A registers never become other-court equivalents", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZ",
      identifier: "KS Praha 65 A 3/2025",
      dependencies: {
        lookup: lookupRows([{ ...row("65 As 3/2025"), ecli: null }]),
      },
    });
    expect(result).toEqual({
      status: "not_found",
      reason: "no_exact_identity",
    });
  });
  test("a single other-court holder is still a mismatch", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZ",
      identifier: "KS Praha 52 A 6/2023",
      dependencies: {
        lookup: lookupRows([
          {
            ...regionalRow("Krajský soud v Hradci Králové", "133"),
            caseNumber: "52 A 6/2023",
            subjectSummary: null,
          },
        ]),
        read: async () => panic("Wrong-court result must not fetch text"),
      },
    });
    expect(result).toMatchObject({
      status: "not_found",
      reason: "not_at_this_court",
      otherCourtCandidates: [
        { court: "Krajský soud v Hradci Králové", subjectSummary: null },
      ],
    });
  });
});
