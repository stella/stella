import { panic } from "better-result";
import { Buffer } from "node:buffer";

import { decodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import { assemblePlKioDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-kio";
import {
  PL_KIO_HTML_BUDGET,
  readPlKioHtml,
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
  Math.floor((PL_KIO_HTML_BUDGET.maxDomAllocations - 204) / 3),
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
const substantiveHtml = markup.replace("</span>", () => `${padding}</span>`);
const workload = process.argv.at(3) ?? "accepted";
const documentHtmlOf = (kind: string) => {
  switch (kind) {
    case "accepted":
      return substantiveHtml;
    case "svg":
      return `<svg><script>${"<g></g>".repeat(100_000)}</script></svg>`;
    case "attributes":
      return `<div ${Array.from({ length: 30_000 }, (_, index) => `a${index}`).join(" ")}></div>`;
    case "plaintext":
      return "x\n\n".repeat(100_000);
    default:
      return panic(`Unknown KIO memory workload: ${kind}`);
  }
};
const documentHtml = documentHtmlOf(workload);
const documentBytes = Buffer.byteLength(documentHtml);
const budget = readPlKioHtml(documentHtml).type;
// Each span allocates an element, an attribute and a text node; parse5 also
// creates document/html/head/body nodes for this fragment.
const boundaryRepeats = Math.floor(
  (PL_KIO_HTML_BUDGET.maxDomAllocations - 4) / 3,
);
const markupBoundaryHtml = '<span a="x">text</span>'.repeat(boundaryRepeats);
const boundaryBudget = readPlKioHtml(markupBoundaryHtml).type;
const overflowBudget = readPlKioHtml(
  `${markupBoundaryHtml}<span>x</span>`,
).type;
const markupTokens = countMarkupTokens(documentHtml);
if (
  (workload === "accepted" && documentBytes !== targetBytes) ||
  targetBytes > PL_KIO_HTML_BUDGET.maxBytes ||
  (workload === "accepted" && budget !== "accepted") ||
  boundaryBudget !== "accepted" ||
  overflowBudget !== "markup-budget-exceeded"
) {
  panic(
    `KIO fixture missed its budget boundary: ${documentBytes}/${targetBytes}, ${budget}/${boundaryBudget}/${overflowBudget}`,
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
    astBlocks: decision.documentAst.blocks?.length ?? 0,
    rawEnvelopeBytes: Buffer.byteLength(decision.sourceRaw ?? ""),
    rawContainsDocument: true,
    budgetType: decision.metadata["documentStatus"] ?? budget,
    markupTokens,
    boundaryBudgetType: boundaryBudget,
    overflowBudgetType: overflowBudget,
  })}\n`,
);