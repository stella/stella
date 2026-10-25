import { panic, Result, TaggedError } from "better-result";
import * as cheerio from "cheerio";
import { isText } from "domhandler";
import { Buffer } from "node:buffer";
import { adapter } from "parse5-htmlparser2-tree-adapter";

import { hasPlKioAttributeBudget } from "./pl-kio-attribute-budget";

export const PL_KIO_RESPONSE_BYTE_CAP = {
  listing: 16 * 1024 * 1024,
  detail: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
} as const;

export type PlKioResponseKind = keyof typeof PL_KIO_RESPONSE_BYTE_CAP;

export const PL_KIO_DOCUMENT_REJECTION = {
  OVERSIZED: "oversized",
  MARKUP_BUDGET_EXCEEDED: "markup-budget-exceeded",
} as const;

export class PlKioHtmlBudgetError extends TaggedError("PlKioHtmlBudgetError")<{
  message: string;
  reason: (typeof PL_KIO_DOCUMENT_REJECTION)[keyof typeof PL_KIO_DOCUMENT_REJECTION];
}> {}

const rejectPlKioHtmlBudget = (message: string): never => {
  // oxlint-disable-next-line result-boundary/no-throw-outside-boundary -- parser callbacks cannot return a Result; assemblePlKioDecision converts this typed refusal to Result.err
  throw new PlKioHtmlBudgetError({
    message,
    reason: PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED,
  });
};

export const PL_KIO_HTML_BUDGET = {
  maxDomAllocations: 10_000,
  maxAttributesPerTag: 512,
  maxAttributesTotal: 20_000,
  maxScanStepsPerCharacter: 8,
  reject: rejectPlKioHtmlBudget,
} as const;

/** Bound allocations in the same parse5 tree builder that Cheerio consumes. */
type LoadPlKioHtmlOptions = { maxBytes: number };

export const loadPlKioHtml = (
  html: string,
  { maxBytes }: LoadPlKioHtmlOptions,
) => {
  let rejection: PlKioHtmlBudgetError["reason"] | undefined;
  if (Buffer.byteLength(html, "utf-8") > maxBytes) {
    rejection = PL_KIO_DOCUMENT_REJECTION.OVERSIZED;
  } else if (!hasPlKioAttributeBudget(html, PL_KIO_HTML_BUDGET)) {
    rejection = PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED;
  }
  if (rejection !== undefined) {
    return Result.err(
      new PlKioHtmlBudgetError({
        message: "KIO HTML exceeds input budget",
        reason: rejection,
      }),
    );
  }
  let allocations = 0;
  const charge = (count: number) => {
    allocations += count;
    if (allocations > PL_KIO_HTML_BUDGET.maxDomAllocations) {
      PL_KIO_HTML_BUDGET.reject("KIO HTML exceeds DOM allocation budget");
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
  return Result.try({
    try: () => cheerio.load(html, { treeAdapter }),
    catch: (error) => {
      if (error instanceof PlKioHtmlBudgetError) {
        return error;
      }
      return panic("Unexpected failure while parsing KIO HTML", error);
    },
  });
};

export const readPlKioHtml = (html: string, options: LoadPlKioHtmlOptions) => {
  const result = loadPlKioHtml(html, options);
  if (Result.isError(result)) {
    return { type: result.error.reason };
  }
  return { type: "accepted", document: result.value } as const;
};
