import { Result, TaggedError } from "better-result";
import * as cheerio from "cheerio";
import { isText } from "domhandler";
import { Buffer } from "node:buffer";
import { adapter } from "parse5-htmlparser2-tree-adapter";

import { hasPlKioAttributeBudget } from "./pl-kio-attribute-budget";

export const PL_KIO_HTML_BUDGET = {
  maxBytes: 2 * 1024 * 1024,
  maxDomAllocations: 20_000,
  maxAttributesPerTag: 512,
  maxAttributesTotal: 20_000,
  maxScanStepsPerCharacter: 8,
} as const;

export const PL_KIO_DOCUMENT_REJECTION = {
  OVERSIZED: "oversized",
  MARKUP_BUDGET_EXCEEDED: "markup-budget-exceeded",
} as const;

export class PlKioHtmlBudgetError extends TaggedError("PlKioHtmlBudgetError")<{
  message: string;
  reason: (typeof PL_KIO_DOCUMENT_REJECTION)[keyof typeof PL_KIO_DOCUMENT_REJECTION];
}> {}

/** Bound allocations in the same parse5 tree builder that Cheerio consumes. */
export const loadPlKioHtml = (html: string) => {
  let rejection: PlKioHtmlBudgetError["reason"] | undefined;
  if (Buffer.byteLength(html, "utf-8") > PL_KIO_HTML_BUDGET.maxBytes) {
    rejection = PL_KIO_DOCUMENT_REJECTION.OVERSIZED;
  } else if (!hasPlKioAttributeBudget(html, PL_KIO_HTML_BUDGET)) {
    rejection = PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED;
  }
  if (rejection !== undefined) {
    throw new PlKioHtmlBudgetError({
      message: "KIO HTML exceeds input budget",
      reason: rejection,
    });
  }
  let allocations = 0;
  const charge = (count: number) => {
    allocations += count;
    if (allocations > PL_KIO_HTML_BUDGET.maxDomAllocations) {
      throw new PlKioHtmlBudgetError({
        message: "KIO HTML exceeds DOM allocation budget",
        reason: PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED,
      });
    }
  };
  const treeAdapter = {
    ...adapter,
    createDocument: () => {
      charge(1);
      return adapter.createDocument();
    },
    createDocumentFragment: () => {
      charge(1);
      return adapter.createDocumentFragment();
    },
    createElement: (...args) => {
      charge(1 + args[2].length);
      return adapter.createElement(...args);
    },
    createCommentNode: (...args) => {
      charge(1);
      return adapter.createCommentNode(...args);
    },
    createTextNode: (...args) => {
      charge(1);
      return adapter.createTextNode(...args);
    },
    // These methods allocate internally without calling the wrapped constructors.
    insertText: (parent, text) => {
      const last = parent.children.at(-1);
      if (last === undefined || !isText(last)) {
        charge(1);
      }
      return adapter.insertText(parent, text);
    },
    insertTextBefore: (parent, text, reference) => {
      const previous = reference.prev;
      if (previous === null || !isText(previous)) {
        charge(1);
      }
      return adapter.insertTextBefore(parent, text, reference);
    },
    setDocumentType: (...args) => {
      charge(1);
      return adapter.setDocumentType(...args);
    },
    adoptAttributes: (...args) => {
      charge(args[1].length);
      return adapter.adoptAttributes(...args);
    },
  } satisfies typeof adapter;
  return cheerio.load(html, { treeAdapter });
};

export const readPlKioHtml = (html: string) => {
  const result = Result.try({
    try: () => loadPlKioHtml(html),
    catch: (error) => {
      if (error instanceof PlKioHtmlBudgetError) {
        return error;
      }
      throw error;
    },
  });
  if (Result.isError(result)) {
    return { type: result.error.reason };
  }
  return { type: "accepted", document: result.value } as const;
};
