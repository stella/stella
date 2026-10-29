/**
 * Every captured Tribunal case page, built into its rulings by the adapter
 * and checked against what the projection reads from the stored raw.
 */
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  assemblePlTkDecision,
  plTkRawPartsOf,
} from "@/api/handlers/case-law/ingestion/adapters/pl-tk";
import type { PlTkListingRow } from "@/api/handlers/case-law/ingestion/adapters/pl-tk";
import {
  parsePlTkPage,
  readPlTkCasePage,
} from "@/api/handlers/case-law/ingestion/parsers/pl-tk";
import { plTkRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-tk";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

const FIXTURES = new URL("../../parsers/__fixtures__/", import.meta.url);

const CASE_PAGES = [
  "pl-tk-case-k-2-26.html.gz",
  "pl-tk-case-k-44-16.html.gz",
  "pl-tk-case-sk-14-11.html.gz",
  "pl-tk-case-ts-70-24.html.gz",
  "pl-tk-case-u-1-86.html.gz",
  "pl-tk-case-w-3-94.html.gz",
];

const casePage = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(
      new Uint8Array(await Bun.file(new URL(name, FIXTURES)).arrayBuffer()),
    ),
  );

const rowFor = (documentId: string): PlTkListingRow => ({
  stage: "merits",
  documentId,
  caseId: undefined,
  caseNumber: undefined,
  decisionForm: undefined,
  decisionDate: undefined,
  subject: undefined,
  rowHtml: undefined,
  defect: undefined,
});

const project = async (sourceRaw: string | undefined) => {
  if (plTkRetention.type !== "checked") {
    return panic("pl-tk is a checked source");
  }
  return await plTkRetention.project(
    sourceRaw ?? panic("the decision stores no raw"),
  );
};

/** Every ruling a case page holds text for, as the adapter builds it. */
const rulingsOf = async (name: string) => {
  const page = await casePage(name);
  const record = readPlTkCasePage(parsePlTkPage(page));
  const rulings = [];
  for (const documentId of record?.rulingIds ?? []) {
    const row = rowFor(documentId);
    const built = assemblePlTkDecision({
      row,
      casePage: page,
      rawParts: plTkRawPartsOf(row, page),
    });
    if (built.type === "built" && hasUsableAst(built.decision.documentAst)) {
      rulings.push({
        documentId,
        blocks: built.decision.documentAst.blocks,
        sourceRaw: built.decision.sourceRaw,
      });
    }
  }
  return rulings;
};

describe("pl-tk retention", () => {
  test.each(CASE_PAGES)(
    "every ruling on %s keeps the text the portal served",
    async (name) => {
      const rulings = await rulingsOf(name);
      expect(rulings.length).toBeGreaterThan(0);
      for (const ruling of rulings) {
        const projection = await project(ruling.sourceRaw);
        if (projection.type !== "source") {
          panic(`${name} ${ruling.documentId}: ${projection.type}`);
        }
        const result = validateAst(
          projection.source,
          ruling.blocks,
          projection.options,
        );
        console.info(
          `pl-tk ${name} ${ruling.documentId}: retainedPct=${result.stats.retainedPct.toFixed(1)} missingWords=${String(result.stats.missingWords.length)}`,
        );
        expect({ documentId: ruling.documentId, ok: result.ok }).toEqual({
          documentId: ruling.documentId,
          ok: true,
        });
      }
    },
  );

  test("a ruling whose blocks lost text is caught against the portal's page", async () => {
    const [ruling] = await rulingsOf("pl-tk-case-k-2-26.html.gz");
    const whole = ruling ?? panic("the case page built no ruling");
    const projection = await project(whole.sourceRaw);
    if (projection.type !== "source") {
      panic(`projection: ${projection.type}`);
    }
    const truncated = validateAst(
      projection.source,
      whole.blocks.slice(0, 40),
      projection.options,
    );
    expect(truncated.issues.map((issue) => issue.code)).toContain(
      "CONTENT_LOSS",
    );
  });

  test("only the listed ruling's text is read, not the rest of the page", async () => {
    const page = await casePage("pl-tk-case-k-2-26.html.gz");
    const projection = await project(
      encodeSourceRawEnvelope(plTkRawPartsOf(rowFor("25564"), page)),
    );
    const source =
      projection.type === "source" && typeof projection.source !== "string"
        ? projection.source.paragraphs.join("\n")
        : panic("the ruling's text was not read");
    expect(source.length).toBeGreaterThan(0);
    // The case record's labels sit outside the text container.
    expect(source).not.toContain("Data wpływu do TK");
  });

  test("a ruling the page holds no text for, and a raw that is no envelope", async () => {
    expect(
      await project(
        encodeSourceRawEnvelope(
          plTkRawPartsOf(rowFor("1"), "<html><body></body></html>"),
        ),
      ),
    ).toEqual({ type: "no-text", reason: "not-published" });
    expect(
      await project(
        encodeSourceRawEnvelope(plTkRawPartsOf(rowFor("1"), undefined)),
      ),
    ).toEqual({ type: "no-text", reason: "not-published" });
    expect(await project("<html></html>")).toEqual({
      type: "unreadable",
      reason: "unreadable-envelope",
    });
  });
});
