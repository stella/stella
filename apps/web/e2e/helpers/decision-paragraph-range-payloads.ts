import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { dockedChatLegalPayloads } from "./docked-chat-legal-payloads";

const documentAst = {
  version: 1,
  source: {
    system: "synthetic",
    documentId: "paragraph-range-fixture",
    webUrl: "",
    printUrl: "",
  },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: Array.from({ length: 80 }, (_, index) => {
    // Court numbers intentionally differ from parser counters: 48 maps to p-28.
    const number = index + 21;
    const text = `Court paragraph ${String(number)}. ${"The court considered the submitted evidence and the parties' arguments. ".repeat(8)}`;
    return {
      id: `block-${String(index + 1)}`,
      anchorId: `p-${String(index + 1)}`,
      type: "paragraph" as const,
      number,
      inlines: [{ type: "text" as const, text }],
      plainText: text,
    };
  }),
} satisfies DocumentAst;

const decision = {
  ...dockedChatLegalPayloads.decision,
  documentAst,
  fulltext: documentAst.blocks.map(({ plainText }) => plainText).join("\n\n"),
};

const unavailable = {
  ...decision,
  documentAst: null,
  fulltext: null,
  hasDocument: false,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: true,
};

export const decisionParagraphRangePayloads = { decision, unavailable };
