import { panic } from "better-result";
import { Buffer } from "node:buffer";

import { decodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import { assemblePlKioDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-kio";
import {
  PL_KIO_HTML_BUDGET,
  inspectPlKioHtmlBudget,
} from "@/api/handlers/case-law/ingestion/adapters/pl-kio-response-budget";

const targetBytes = Number(process.argv.at(2));
if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
  panic("KIO memory fixture requires a positive target byte count");
}

const detailHtml = await Bun.file(
  new URL("pl-kio-detail-30308.html", import.meta.url),
).text();

const countMarkupTokens = (html: string) => {
  let tokens = 0;
  for (const character of html) {
    if (character === "<" || character === "=") {
      tokens += 1;
    }
  }
  return tokens;
};

const spanCount = Math.min(
  Math.floor(targetBytes / 256),
  Math.floor((PL_KIO_HTML_BUDGET.maxMarkupTokens - 204) / 3),
);
const prefix = "<html><body>";
const suffix = "</body></html>";
const span = (index: number) =>
  `<span style="font-weight:bold">Ustalenie ${index}. </span>`;
const paragraphs: string[] = [];
for (let index = 0; index < spanCount; index += 1) {
  if (index % 66 === 0) {
    paragraphs.push("<p>");
  }
  paragraphs.push(span(index));
  if (index % 66 === 65 || index === spanCount - 1) {
    paragraphs.push("</p>");
  }
}
const markup = prefix + paragraphs.join("") + suffix;
const paddingBytes = targetBytes - Buffer.byteLength(markup);
if (paddingBytes < 0) {
  panic("KIO memory fixture requires room for substantive document text");
}
const text = "Izba stwierdza okolicznosci. ";
const padding = text
  .repeat(Math.ceil(paddingBytes / text.length))
  .slice(0, paddingBytes);
const documentHtml = markup.replace("</span>", () => `${padding}</span>`);
const documentBytes = Buffer.byteLength(documentHtml);
const budget = inspectPlKioHtmlBudget(documentHtml);
const boundaryRepeats = Math.floor(
  (PL_KIO_HTML_BUDGET.maxMarkupTokens - 5) / 3,
);
const markupBoundaryHtml = `${'<span a="x">text</span>'.repeat(boundaryRepeats)}<span a="x">x</span><span></span>`;
const boundaryBudget = inspectPlKioHtmlBudget(markupBoundaryHtml);
const overflowBudget = inspectPlKioHtmlBudget(`${markupBoundaryHtml}<span>`);
const markupTokens = countMarkupTokens(documentHtml);
if (
  documentBytes !== targetBytes ||
  targetBytes > PL_KIO_HTML_BUDGET.maxBytes ||
  budget.type !== "accepted" ||
  countMarkupTokens(markupBoundaryHtml) !==
    PL_KIO_HTML_BUDGET.maxMarkupTokens ||
  boundaryBudget.type !== "accepted" ||
  overflowBudget.type !== "markup-budget-exceeded"
) {
  panic(
    `KIO fixture missed its budget boundary: ${documentBytes}/${targetBytes}, ${budget.type}/${boundaryBudget.type}/${overflowBudget.type}`,
  );
}

const assembled = assemblePlKioDecision({
  item: {
    id: "30308",
    documentType: "wyrok",
    signature: "KIO 2845/25",
    issueDate: "01-09-2025",
  },
  detailHtml,
  document: { type: "read", html: documentHtml },
});
if (assembled.type !== "built") {
  panic(`KIO memory fixture was not assembled: ${assembled.type}`);
}

const decision = assembled.decision;
const rawParts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
if (rawParts === null || !Object.values(rawParts).includes(documentHtml)) {
  panic("KIO memory fixture document was not retained in the raw envelope");
}

process.stdout.write(
  `${JSON.stringify({
    targetBytes,
    documentBytes,
    fulltextChars: decision.fulltext?.length ?? 0,
    astBlocks: decision.documentAst.blocks.length,
    rawEnvelopeBytes: Buffer.byteLength(decision.sourceRaw ?? ""),
    rawContainsDocument: true,
    budgetType: budget.type,
    markupTokens,
    boundaryBudgetType: boundaryBudget.type,
    overflowBudgetType: overflowBudget.type,
  })}\n`,
);