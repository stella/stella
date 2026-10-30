import { panic } from "better-result";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";

import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  assemblePlKioDecision,
  plKioAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/pl-kio";
import {
  PL_KIO_HTML_BUDGET,
  PL_KIO_RESPONSE_BYTE_CAP,
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

const prefix = "<html><body>";
const suffix = "</body></html>";
// Real KIO rulings are long prose paragraphs. Keep enough separate paragraphs
// to exercise the AST while leaving the markup allocation budget well clear.
const paragraphCount = Math.min(16, Math.floor(targetBytes / 1024));
const lowMarkupHtml = () => {
  const paragraphs: string[] = [];
  for (let index = 0; index < paragraphCount; index += 1) {
    paragraphs.push(`<p>Ustalenie ${index}. </p>`);
  }
  const markup = prefix + paragraphs.join("") + suffix;
  const paddingBytes = targetBytes - Buffer.byteLength(markup);
  if (paddingBytes < 0) {
    panic("KIO memory fixture requires room for substantive document text");
  }
  let paddingRemaining = paddingBytes;
  let paragraphsRemaining = paragraphCount;
  return markup.replaceAll("</p>", () => {
    const padding = "x".repeat(
      Math.ceil(paddingRemaining / paragraphsRemaining),
    );
    paddingRemaining -= padding.length;
    paragraphsRemaining -= 1;
    return `${padding}</p>`;
  });
};
const workload = process.argv.at(3) ?? "accepted";
const path = process.argv.at(4) ?? "fetch";
const worstAcceptedHtml = () => {
  // Three allocations and markup tokens per attributed span leave the parser's
  // four document nodes inside the allocation budget while exercising its edge.
  const spanCount = Math.floor((PL_KIO_HTML_BUDGET.maxDomAllocations - 4) / 3);
  const inlineMarkup = '<span a="x">tekst</span>'.repeat(spanCount);
  const shell = `${prefix}${inlineMarkup}${suffix}`;
  const padding = targetBytes - Buffer.byteLength(shell);
  if (padding < 0) {
    panic("KIO worst accepted fixture exceeds its target byte count");
  }
  return `${prefix}<span a="x">${"x".repeat(padding)}tekst</span>${'<span a="x">tekst</span>'.repeat(spanCount - 1)}${suffix}`;
};

const documentHtmlOf = (kind: string) => {
  switch (kind) {
    case "accepted":
      return targetBytes === PL_KIO_RESPONSE_BYTE_CAP.document
        ? worstAcceptedHtml()
        : lowMarkupHtml();
    case "svg":
      return `<svg><script>${"<g></g>".repeat(100_000)}</script></svg>`;
    case "attributes":
      return `<div ${Array.from({ length: 200_000 }, (_, index) => `a${index}`).join(" ")}></div>`;
    case "plaintext":
      return "x\n\n".repeat(100_000);
    case "rich":
      return `<html><body>${'<span a="x">tekst</span>'.repeat(PL_KIO_HTML_BUDGET.maxDomAllocations)}</body></html>${"x".repeat(targetBytes)}`.slice(
        0,
        targetBytes,
      );
    default:
      return panic(`Unknown KIO memory workload: ${kind}`);
  }
};
let documentHtml = documentHtmlOf(workload);
const documentBytes = Buffer.byteLength(documentHtml);
const markupTokens = countMarkupTokens(documentHtml);
// Each span allocates an element, an attribute and a text node; parse5 also
// creates document/html/head/body nodes for this fragment.
const boundaryRepeats = Math.floor(
  (PL_KIO_HTML_BUDGET.maxDomAllocations - 4) / 3,
);
const markupBoundaryHtml = '<span a="x">text</span>'.repeat(boundaryRepeats);
const boundaryBudget = readPlKioHtml(markupBoundaryHtml, {
  maxBytes: PL_KIO_RESPONSE_BYTE_CAP.document,
}).type;
const overflowBudget = readPlKioHtml(
  `${markupBoundaryHtml}${"<span>x</span>".repeat(2)}`,
  {
    maxBytes: PL_KIO_RESPONSE_BYTE_CAP.document,
  },
).type;
if (
  (workload === "accepted" && documentBytes !== targetBytes) ||
  targetBytes > PL_KIO_RESPONSE_BYTE_CAP.document ||
  boundaryBudget !== "accepted" ||
  overflowBudget !== "markup-budget-exceeded"
) {
  panic(
    `KIO fixture missed its budget boundary: ${documentBytes}/${targetBytes}, ${boundaryBudget}/${overflowBudget}`,
  );
}

const assemble = () =>
  assemblePlKioDecision({
    item: {
      id: "30308",
      documentType: "wyrok",
      signature: "KIO 2845/25",
      issueDate: "01-09-2025",
    },
    detailHtml,
    document: { type: "read", html: documentHtml },
  });
let assembled: ReturnType<typeof assemblePlKioDecision>;
if (path === "replay") {
  const raw = new TextEncoder().encode(
    encodeSourceRawEnvelope({
      listing: JSON.stringify({
        id: "30308",
        documentType: "wyrok",
        signature: "KIO 2845/25",
        issueDate: "01-09-2025",
      }),
      detail: detailHtml,
      document: documentHtml,
    }),
  );
  // Production replay starts from stored bytes, not a second live copy of the
  // source string used to build this fixture's envelope.
  documentHtml = "";
  Bun.gc(true);
  const reparse = plKioAdapter.reparseStoredRaw;
  if (reparse === undefined) {
    panic("KIO memory fixture requires stored raw replay");
  }
  const replay = await reparse({
    raw,
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    sourceDocumentId: "30308",
    caseNumber: "KIO 2845/25",
    language: "pl",
    court: String(),
    ecli: null,
    decisionDate: "2025-09-01",
    decisionType: "wyrok",
    sourceUrl: null,
    documentUrl: null,
    metadata: {},
  });
  if (replay.type !== "parsed") {
    panic(`KIO memory fixture replay was not parsed: ${replay.type}`);
  }
  assembled = { type: "built", decision: replay.result };
} else if (path === "fetch") {
  assembled = assemble();
} else {
  panic(`Unknown KIO memory path: ${path}`);
}
if (assembled.type !== "built") {
  panic(`KIO memory fixture was not assembled: ${assembled.type}`);
}

const decision = assembled.decision;
const budget = decision.metadata["documentStatus"] ?? "accepted";
if (typeof budget !== "string") {
  panic("KIO memory fixture document status was not a string");
}
if (workload === "accepted" && budget !== "accepted") {
  panic(`KIO fixture accepted workload was rejected: ${budget}`);
}
const rawParts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
if (
  rawParts === null ||
  Buffer.byteLength(rawParts["document"] ?? "") !== documentBytes
) {
  panic("KIO memory fixture document was not retained in the raw envelope");
}

// This process's own high-water RSS. On Linux VmHWM starts afresh at exec, so
// it excludes the forked parent's pages (which ru_maxrss would count) and,
// unlike polling, cannot miss a short spike. Elsewhere the child's own maxRSS
// (kilobytes) is exact, since posix_spawn does not inherit the parent's peak.
const PROC_STATUS = "/proc/self/status";
const peakRssBytes = existsSync(PROC_STATUS)
  ? Number(
      /^VmHWM:\s+(?<kilobytes>\d+) kB$/mu.exec(
        readFileSync(PROC_STATUS, "utf-8"),
      )?.groups?.["kilobytes"] ?? panic("VmHWM missing from /proc/self/status"),
    ) * 1024
  : process.resourceUsage().maxRSS * 1024;

process.stdout.write(
  `${JSON.stringify({
    peakRssBytes,
    targetBytes,
    documentBytes,
    fulltextChars: decision.fulltext?.length ?? 0,
    astBlocks:
      "blocks" in decision.documentAst
        ? decision.documentAst.blocks.length
        : null,
    rawEnvelopeBytes: Buffer.byteLength(decision.sourceRaw ?? ""),
    rawContainsDocument: true,
    budgetType: budget,
    markupTokens,
    path,
    boundaryBudgetType: boundaryBudget,
    overflowBudgetType: overflowBudget,
  })}\n`,
);