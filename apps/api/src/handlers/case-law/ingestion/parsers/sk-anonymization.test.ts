import { PDF } from "@libpdf/core";
import { panic } from "better-result";
import { expect, test } from "bun:test";

import { plainTextOf } from "@stll/legal-ast/document-ast";

import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import type { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import { parseSkDecisionPdf } from "@/api/lib/legal-search/parsers/sk-courts";
import { segmentDecision } from "@/api/lib/legal-search/segment-decision";

import { parseSkUsDocumentXhtml } from "./sk-us";

type SlovakAdapter = {
  [
    Key in keyof typeof ADAPTER_MANIFESTS
  ]: (typeof ADAPTER_MANIFESTS)[Key]["country"] extends "SVK" ? Key : never;
}[keyof typeof ADAPTER_MANIFESTS];

// Published 10C/55/2022 uses these literal replacements, not empty redaction bars.
const SOURCE_MARKERS = ["D. G.", "D.. XX.XX.XXXX", "XXX/XXX"];
const sourceText = `Osoba: ${SOURCE_MARKERS.join(", ")}.`;

const parsers = {
  "sk-courts": async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText(sourceText, { x: 70, y: 700, size: 10 });
    return await parseSkDecisionPdf({
      pdfBytes: await pdf.save(),
      caseNumber: "10C/55/2022",
      court: "Okresný súd Galanta",
      ecli: undefined,
      decisionDate: undefined,
      decisionType: "rozsudok",
    });
  },
  "sk-us": async () =>
    parseSkUsDocumentXhtml({
      xhtml: `<html><body><publisher-wrapper><span style="font-size: 18px">UZNESENIE<br/><br/></span><p>Osoba: <unknown-anonymization class="anon-block">${SOURCE_MARKERS.join(", ")}</unknown-anonymization>.</p><p>Ďalší <span style="color: #000000; background-color: #000000">&nbsp;&nbsp;&nbsp;</span> účastník.</p></publisher-wrapper></body></html>`,
      caseNumber: "I. ÚS 1/2026",
      court: "Ústavný súd Slovenskej republiky",
      ecli: undefined,
      decisionDate: undefined,
      decisionType: "uznesenie",
      documentUrl: "https://example.test/decision",
    }),
} satisfies Record<SlovakAdapter, () => ReturnType<typeof parseSkDecisionPdf>>;

for (const [adapter, parse] of Object.entries(parsers)) {
  test(`${adapter} anonymization markers survive parsing and stored text projections`, async () => {
    const parsed = await parse();
    const metadata = parsed.documentAst.metadata;
    if (metadata.type === "guidance") {
      panic("A court parser returned non-decision metadata");
    }
    const sanitized = sanitizeResult({
      caseNumber: metadata.caseNumber ?? panic("Missing decision case number"),
      court: metadata.court ?? panic("Missing decision court"),
      country: "SVK",
      language: "sk",
      metadata: {},
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      rawHash: "",
      documentAst: parsed.documentAst,
      fulltext: parsed.fulltext,
      sections: segmentDecision(parsed.fulltext),
    });
    const astText = parsed.documentAst.blocks
      .flatMap((block) =>
        block.type === "heading" || block.type === "paragraph"
          ? [plainTextOf(block.inlines)]
          : [],
      )
      .join(" ");
    for (const marker of SOURCE_MARKERS) {
      expect(astText).toContain(marker);
      expect(sanitized.fulltext).toContain(marker);
      expect(JSON.stringify(sanitized.documentAst)).toContain(marker);
      expect(sanitized.sections?.map(({ text }) => text).join(" ")).toContain(
        marker,
      );
    }
    if (adapter === "sk-us") {
      expect(astText).toContain("anonymizované");
      expect(sanitized.fulltext).toContain("anonymizované");
      expect(JSON.stringify(sanitized.documentAst)).toContain(
        '"anonymized":true',
      );
      expect(sanitized.sections?.map(({ text }) => text).join(" ")).toContain(
        "anonymizované",
      );
    }
  });
}
