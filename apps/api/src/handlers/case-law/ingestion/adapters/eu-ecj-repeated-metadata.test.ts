import { expect, test } from "bun:test";
import JSZip from "jszip";

import {
  euEcjAdapter,
  readEcjFormexArchive,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import {
  ecjFormexDocuments,
  FORMEX_ARCHIVE_PREFIX,
} from "@/api/handlers/case-law/ingestion/parsers/eu-ecj-formex-parts";
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/ingestion-types";

const primary =
  "<DOC><BIB.JUDGMENT><REF.CASE>C-1/26</REF.CASE><AUTHOR>CJ</AUTHOR><NO.CELEX>62026CJ0001</NO.CELEX></BIB.JUDGMENT></DOC>";
const joined =
  "<DOC><BIB.JUDGMENT><REF.CASE>C-2/26</REF.CASE><AUTHOR>GCEU</AUTHOR><NO.CELEX>62026CJ0002</NO.CELEX></BIB.JUDGMENT></DOC>";

test("every archive member survives stored replay and repeated bibliography stays ordered", async () => {
  const zip = new JSZip();
  zip.folder("documents");
  zip.file("documents/primary.xml", primary);
  zip.file("documents/joined.xml", joined);
  const asset = new Uint8Array([0, 255, 128, 4]);
  zip.file("assets/figure.bin", asset);
  const formex = await readEcjFormexArchive(
    await zip.generateAsync({ type: "arraybuffer" }),
  );
  expect(ecjFormexDocuments(formex).slice(0, 2)).toEqual([primary, joined]);
  const archive = decodeSourceRawEnvelope(
    formex.slice(FORMEX_ARCHIVE_PREFIX.length),
  );
  expect(Object.keys(archive ?? {})).toEqual([
    "documents/primary.xml",
    "documents/joined.xml",
    "assets/figure.bin",
  ]);
  expect(Buffer.from(archive?.["assets/figure.bin"] ?? "", "base64")).toEqual(
    Buffer.from(asset),
  );

  const reparse = euEcjAdapter.reparseStoredRaw;
  expect(reparse).toBeDefined();
  if (reparse === undefined) {
    return;
  }
  const outcome = await reparse({
    raw: new TextEncoder().encode(
      encodeSourceRawEnvelope({
        document:
          "<html><body><div class='listNotice'><p>Judgment body remains readable.</p></div></body></html>",
        formex,
      }),
    ),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    caseNumber: "C-1/26",
    sourceDocumentId: "62026CJ0001:en",
    language: "en",
    court: "Court of Justice",
    ecli: "ECLI:EU:C:2026:1",
    decisionDate: "2026-01-01",
    decisionType: "judgment",
    sourceUrl: undefined,
    documentUrl: undefined,
    metadata: { celex: "62026CJ0001" },
  });
  expect(outcome.type).toBe("parsed");
  if (outcome.type !== "parsed") {
    return;
  }
  expect(outcome.result.metadata["publisherCaseNumber"]).toEqual([
    "C-1/26",
    "C-2/26",
  ]);
  expect(outcome.result.metadata["formexCelex"]).toEqual([
    "62026CJ0001",
    "62026CJ0002",
  ]);
  expect(outcome.result.metadata["formexAuthors"]).toEqual(["CJ", "GCEU"]);
  const stored = decodeSourceRawEnvelope(outcome.result.sourceRaw ?? "");
  expect(stored?.["formex"]).toBe(formex);
});
