import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  assembleAtFindokDecision,
  parseFindokManifest,
} from "@/api/handlers/case-law/ingestion/adapters/at-findok";
import { atFindokRetention } from "@/api/handlers/case-law/ingestion/retention/sources/at-findok";
import { loadDocxArchive } from "@/api/lib/docx-archive";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { atFindokFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";

const PARSERS_DIR = new URL("../../parsers/__fixtures__/", import.meta.url);

/** The manifest row the adapter tests pair with the recorded documents. */
const MANIFEST_ITEM = {
  stammNr: 152_257,
  pathZip: "152/152257/152257.zip",
  pathPdf: "152/152257/152257.1.pdf",
  dokumenttyp: "Bescheidbeschwerde - Einzel - Erkenntnis",
  behoerde: "BFG",
  appdat: "14.07.2026",
  gz: "RV/7500368/2026",
  titel: "Parkometerfall, 15 Minuten-Parkscheine verwendet",
  gueltigAb: "",
  inFindokSeitDate: "2026-08-06T14:54:41.882132",
  inFindokSeit: "06.08.2026 02:54:41",
  gueltig: true,
  dokumentId: "b68202a0-55e4-4dea-9e93-971f0b71ae32",
} as const;

const listedItem = (row: Readonly<Record<string, unknown>>) => {
  const item = parseFindokManifest(
    "bfg",
    JSON.stringify({ generierungsdatum: "07.08.2026 06:16", data: [row] }),
  ).items.at(0);
  if (item === undefined) {
    throw new Error("the manifest fixture states no row");
  }
  return item;
};

const project = async (sourceRaw: string) => {
  if (atFindokRetention.type !== "checked") {
    throw new Error("Findok decisions are checked");
  }
  return await atFindokRetention.project(sourceRaw);
};

const expectRetained = async (decision: IngestionResult) => {
  const ast = decision.documentAst;
  expect(hasUsableAst(ast)).toBe(true);
  const projection = await project(decision.sourceRaw ?? "");
  if (projection.type !== "source") {
    throw new Error(
      `no publisher text projected: ${JSON.stringify(projection)}`,
    );
  }
  const result = validateAst(projection.source, ast.blocks, projection.options);
  expect(
    result.ok,
    `retained ${result.stats.retainedPct.toFixed(1)}%, missing ${result.stats.missingWords.join(", ")}`,
  ).toBe(true);
};

describe("Findok retention projection", () => {
  test("the synthetic decision keeps its publisher text", async () => {
    await expectRetained(await atFindokFixture().buildDecision());
  });

  test("at-findok-bfg-2026.xml keeps its publisher text", async () => {
    await expectRetained(
      assembleAtFindokDecision(
        { collection: "bfg", item: listedItem(MANIFEST_ITEM) },
        {
          documentXml: await Bun.file(
            new URL("at-findok-bfg-2026.xml", PARSERS_DIR),
          ).text(),
        },
      ),
    );
  });

  test("at-findok-152649.zip keeps its publisher text", async () => {
    const archive = await loadDocxArchive(
      await Bun.file(new URL("at-findok-152649.zip", PARSERS_DIR)).bytes(),
      { maxEntries: 20, maxEntryBytes: 4_000_000, maxTotalBytes: 4_000_000 },
    );
    const documentXml = await archive.readEntryString(
      "Gesamt/152649.Entscheidungstext.xml",
    );
    const headnoteXml = await archive.readEntryString(
      "Gesamt/152649.Rechtssaetze.xml",
    );
    if (documentXml === null || headnoteXml === null) {
      throw new Error("the captured archive is missing an entry");
    }
    await expectRetained(
      assembleAtFindokDecision(
        {
          collection: "bfg",
          item: listedItem({
            ...MANIFEST_ITEM,
            stammNr: 152_649,
            pathZip: "152/152649/152649.zip",
            pathPdf: "152/152649/152649.1.pdf",
            gz: "RV/2100968/2026",
            dokumentId: "ffa6f670-dc36-42cc-ae37-52683327a048",
          }),
        },
        { documentXml, headnoteXml },
      ),
    );
  });

  test("reports a document that lost its longest paragraph", async () => {
    const decision = assembleAtFindokDecision(
      { collection: "bfg", item: listedItem(MANIFEST_ITEM) },
      {
        documentXml: await Bun.file(
          new URL("at-findok-bfg-2026.xml", PARSERS_DIR),
        ).text(),
      },
    );
    const projection = await project(decision.sourceRaw ?? "");
    if (projection.type !== "source") {
      throw new Error("the recorded decision projects publisher text");
    }
    const blocks = decision.documentAst.blocks;
    const longest = blocks
      .toSorted((left, right) => right.plainText.length - left.plainText.length)
      .at(0);
    expect(
      validateAst(
        projection.source,
        blocks.filter((block) => block !== longest),
        projection.options,
      ).ok,
    ).toBe(false);
  });

  test("reads the embedded XHTML, not the envelope's bookkeeping", async () => {
    const projection = await project(
      (await atFindokFixture().buildDecision()).sourceRaw ?? "",
    );
    if (projection.type !== "source" || typeof projection.source === "string") {
      throw new Error("the Findok projection states paragraphs");
    }
    const text = projection.source.paragraphs.join("\n");
    expect(text).toContain("Die Beschwerde wird als unbegründet");
    expect(text).not.toContain("dce662f0");
  });

  test("a parse that dropped a top-level heading reads as lost text", async () => {
    const heading =
      "Bundesfinanzgericht entscheidet über die Beschwerde der Gesellschaft gegen den Bescheid des Finanzamtes betreffend Umsatzsteuer für die Jahre zweitausendzwanzig bis zweitausenddreiundzwanzig";
    const body = "Die Beschwerde wird als unbegründet abgewiesen.";
    const xhtml = `<html><body><h1>${heading}</h1><p>${body}</p></body></html>`;
    const projection = await project(
      encodeSourceRawEnvelope({
        listing: "{}",
        "document-xml": `<Segmente><Segment><Segk><txt>${Bun.escapeHTML(xhtml)}</txt></Segk></Segment></Segmente>`,
      }),
    );
    if (projection.type !== "source") {
      throw new Error(`projection answered ${projection.type}`);
    }
    const kept = (text: string) => ({
      id: "p1",
      anchorId: "p1",
      type: "paragraph" as const,
      plainText: text,
      inlines: [{ type: "text" as const, text }],
    });
    expect(
      validateAst(projection.source, [kept(body)], projection.options).ok,
    ).toBe(false);
    expect(
      validateAst(
        projection.source,
        [kept(heading), { ...kept(body), id: "p2", anchorId: "p2" }],
        projection.options,
      ).ok,
    ).toBe(true);
  });

  test("states why a raw holds no decision text", async () => {
    expect(await project("not an envelope")).toEqual({
      type: "unreadable",
      reason: "unreadable-envelope",
    });
    expect(await project(encodeSourceRawEnvelope({ listing: "{}" }))).toEqual({
      type: "no-text",
      reason: "not-published",
    });
    expect(
      await project(
        encodeSourceRawEnvelope({
          listing: "{}",
          "document-xml": "<Segmente><Segment><Segk/></Segment></Segmente>",
        }),
      ),
    ).toEqual({ type: "unreadable", reason: "missing-text-part" });
  });
});
