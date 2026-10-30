// parser-output-unchanged: HTML parser bindings come from their package owner; DOM and serialization behavior are unchanged.
import { isText } from "domhandler";
import { adapter } from "parse5-htmlparser2-tree-adapter";

import { load } from "./load";

type AllocationBudget = {
  maxDomAllocations: number;
  reject: () => never;
};

export const loadWithAllocationBudget = (
  html: string,
  { maxDomAllocations, reject }: AllocationBudget,
) => {
  let allocations = 0;
  // The budget bounds the DOM the publisher's markup builds. Cheerio keeps
  // this tree adapter for every later fragment it parses on the document
  // (`replaceWith(" ")` parses its string), and charging that work too
  // refused documents whose markup fits: AST validation alone parses one
  // fragment per `<br>` of a printed page.
  let parsingPublisherMarkup = true;
  const charge = (count: number) => {
    if (!parsingPublisherMarkup) {
      return;
    }
    allocations += count;
    if (allocations > maxDomAllocations) {
      reject();
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
  const document = load(html, { treeAdapter });
  parsingPublisherMarkup = false;
  return document;
};
