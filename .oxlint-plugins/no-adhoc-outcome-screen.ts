import { eslintCompatPlugin } from "@oxlint/plugins";
// One outcome screen: `OutcomeScreen` from `@stll/ui/outcome-screen`. A flow
// that ends ("ChatGPT is connected", "Signed in", "Invitation declined", "you
// can close this tab") shows that one design, filled with its own words. The
// pages a local loopback server answers cannot run React, so they are
// rendered from the same component into a generated template
// (`scripts/generate-outcome-page.ts`); a hand-written HTML page, a tab that
// closes itself or a hand-built message card is a second design that drifts.
//
// Flags:
//   const html = `<!doctype html><html>...</html>`;   (an HTML document)
//   window.close();                                     (closing the tab)
//   <Frame><FrameHeader><FrameTitle>Agent connected</FrameTitle></FrameHeader></Frame>
//   <div role="status"><h1>Connected</h1></div>
//
// Allows:
//   <OutcomeScreen tone="success" title={...} description={...} closeTab={...} />

import {
  type AstNode,
  elementName,
  everyNode,
  filenameForContext,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  isTestFile,
  jsxName,
  staticStringValue,
} from "./utils.ts";

// The modules allowed to draw an outcome screen, write its HTML document or
// close the tab.
const OUTCOME_OWNERS = [
  "packages/ui/src/components/outcome-screen.tsx",
  "packages/ui/src/components/outcome-screen-view.tsx",
  "scripts/generate-outcome-page.ts",
  "packages/cli/src/auth/outcome-page.gen.ts",
];

// HTML documents that are not outcome screens, each with the reason it is
// its own document. Add one only for a document nobody reads as a page.
const NON_OUTCOME_DOCUMENTS = [
  // The empty shell a streamed SSR response starts from.
  "apps/web/src/ssr-response-stream.ts",
  // Sandboxed frames that host untrusted app or visual markup.
  "apps/api/src/handlers/mcp-app-sandbox/routes.ts",
  "apps/api/src/handlers/visual-sandbox/document.ts",
  "apps/api/src/handlers/visual-sandbox/srcdoc.ts",
  // A stored email rendered for the file viewer.
  "apps/api/src/lib/files/email-to-html.ts",
  // A court page reduced to its body before it is archived.
  "apps/api/src/handlers/case-law/ingestion/retention/sources/cz-nss.ts",
];

// Captured third-party pages a test replays. This rule's own fixture is not
// one of them.
const FIXTURE_PATH =
  /^(?!.*\.oxlint-plugins\/).*(?:(?:^|\/)(?:__fixtures__|fixtures)\/|\.test-fixture\.)/u;

const HTML_DOCTYPE = /<!doctype\s+html/iu;
const HTML_ROOT = /<html[\s>]/iu;
const HTML_DOCUMENT_BODY = /<\/html\s*>|<body[\s>]/iu;

const isHtmlDocument = (text: string) =>
  HTML_DOCTYPE.test(text) ||
  (HTML_ROOT.test(text) && HTML_DOCUMENT_BODY.test(text));

// The static text of a template literal, its expressions dropped.
const templateText = (node: unknown): string | null => {
  if (
    !isAstNode(node) ||
    node.type !== "TemplateLiteral" ||
    !Array.isArray(node.quasis)
  ) {
    return null;
  }
  return node.quasis
    .map((quasi: unknown) => {
      const value: unknown = isAstNode(quasi) ? quasi.value : undefined;
      const cooked =
        typeof value === "object" && value !== null && "cooked" in value
          ? value.cooked
          : undefined;
      return typeof cooked === "string" ? cooked : "";
    })
    .join("");
};

// Globals whose `close()` closes the browsing context.
const WINDOW_GLOBALS = new Set(["window", "globalThis", "self"]);

const isWindowClose = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee;
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return false;
  }
  const property = callee.property;
  const name =
    isIdentifier(property) && callee.computed !== true
      ? property.name
      : staticStringValue(property);
  return (
    name === "close" &&
    isIdentifier(callee.object) &&
    WINDOW_GLOBALS.has(callee.object.name)
  );
};

// What a message card is made of: the frame, its title and description, text,
// layout boxes and links or buttons. Anything else (a form control, a list, a
// table, a component that renders its own content) makes the frame a surface
// with work on it, not an outcome.
const MESSAGE_ELEMENTS = new Set([
  "Frame",
  "FrameHeader",
  "FrameTitle",
  "FrameDescription",
  "FramePanel",
  "FrameFooter",
  "div",
  "section",
  "header",
  "footer",
  "main",
  "p",
  "span",
  "strong",
  "bdi",
  "h1",
  "h2",
  "Button",
  "Link",
  "a",
]);
// A page's own title. A section card titles itself with an `h2`.
const TITLE_ELEMENTS = new Set(["FrameTitle", "h1"]);
const ACTION_ELEMENTS = new Set(["Button", "Link", "a"]);

const jsxElementsUnder = (node: unknown) =>
  everyNode(node).filter(
    (candidate) => candidate.type === "JSXElement" && candidate !== node,
  );

// A slot (`{children}`) means the frame carries content a caller supplies.
const hasChildrenSlot = (frame: unknown): boolean =>
  everyNode(frame).some(
    (node) =>
      node.type === "JSXExpressionContainer" &&
      ((isIdentifier(node.expression) && node.expression.name === "children") ||
        (isAstNode(node.expression) &&
          node.expression.type === "MemberExpression" &&
          isIdentifier(node.expression.property) &&
          node.expression.property.name === "children")),
  );

const isBlankText = (node: unknown) =>
  isAstNode(node) &&
  node.type === "JSXText" &&
  typeof node.value === "string" &&
  node.value.trim() === "";

const meaningfulChildren = (node: AstNode) =>
  Array.isArray(node.children)
    ? node.children.filter((child: unknown) => !isBlankText(child))
    : [];

// Whether `node` is everything its component renders: it reaches a `return`
// (or an arrow's expression body) through wrappers that hold nothing else and
// through branches. A frame among other sections is a card on a page; a frame
// that is the whole render is the page.
const isWholeRender = (node: AstNode): boolean => {
  let current: AstNode = node;
  for (;;) {
    const parent: unknown = current.parent;
    if (!isAstNode(parent)) {
      return false;
    }
    switch (parent.type) {
      case "ReturnStatement":
        return true;
      case "ArrowFunctionExpression":
        return parent.body === current;
      case "JSXElement":
      case "JSXFragment":
        if (meaningfulChildren(parent).length !== 1) {
          return false;
        }
        break;
      case "JSXExpressionContainer":
      case "ParenthesizedExpression":
      case "ConditionalExpression":
      case "LogicalExpression":
        break;
      default:
        return false;
    }
    current = parent;
  }
};

// A frame that is the whole render and holds a page title, an optional
// description and at most one way on: the shape every hand-built outcome card
// took.
const isMessageCard = (frame: AstNode): boolean => {
  if (!isWholeRender(frame) || hasChildrenSlot(frame)) {
    return false;
  }
  const names = jsxElementsUnder(frame).map(elementName);
  if (names.some((name) => name === null || !MESSAGE_ELEMENTS.has(name))) {
    return false;
  }
  const hasTitle = names.some(
    (name) => name !== null && TITLE_ELEMENTS.has(name),
  );
  const actions = names.filter(
    (name) => name !== null && ACTION_ELEMENTS.has(name),
  ).length;
  return hasTitle && actions <= 1;
};

const roleAttributeValue = (opening: unknown): string | null => {
  if (!isAstNode(opening) || !Array.isArray(opening.attributes)) {
    return null;
  }
  for (const attribute of opening.attributes) {
    if (
      isAstNode(attribute) &&
      attribute.type === "JSXAttribute" &&
      jsxName(attribute.name) === "role"
    ) {
      const value = attribute.value;
      if (isStringLiteral(value)) {
        return value.value;
      }
      if (isAstNode(value) && value.type === "JSXExpressionContainer") {
        return staticStringValue(value.expression);
      }
    }
  }
  return null;
};

// A live status region that announces a heading: an outcome page, not an
// inline status line.
const isHeadedStatusRegion = (element: unknown): boolean =>
  isAstNode(element) &&
  roleAttributeValue(element.openingElement) === "status" &&
  jsxElementsUnder(element).some((child) => {
    const name = elementName(child);
    return name !== null && TITLE_ELEMENTS.has(name);
  });

const OWNER_HINT =
  "Use `OutcomeScreen` from '@stll/ui/outcome-screen' so every flow that ends shows the one outcome design";

export default eslintCompatPlugin({
  meta: { name: "no-adhoc-outcome-screen" },
  rules: {
    "no-adhoc-outcome-screen": {
      meta: {
        type: "problem",
        messages: {
          htmlDocument: `Do not write an HTML page by hand: it becomes a second outcome design that nobody keeps in step. ${OWNER_HINT}; a page served without React fills the template \`scripts/generate-outcome-page.ts\` renders from it.`,
          windowClose: `Do not close the tab from here: closing it, and falling back when the browser refuses, is the outcome screen's job. ${OWNER_HINT} with its \`closeTab\` option.`,
          messageCard: `Do not build an outcome screen from a frame with a title and one action. ${OWNER_HINT}.`,
          statusRegion: `Do not build an outcome screen from a status region with a heading. ${OWNER_HINT}.`,
        },
        schema: [],
      },
      createOnce(context) {
        // Read per file: `context.filename` is not available while the rule
        // is being registered.
        const isOwner = () => {
          const filename = filenameForContext(context);
          return OUTCOME_OWNERS.some((owner) => filename.endsWith(owner));
        };
        const mayHoldDocument = () => {
          const filename = filenameForContext(context);
          return (
            isOwner() ||
            isTestFile(filename) ||
            FIXTURE_PATH.test(filename) ||
            NON_OUTCOME_DOCUMENTS.some((file) => filename.endsWith(file))
          );
        };
        return {
          Literal(node) {
            if (
              isStringLiteral(node) &&
              isHtmlDocument(node.value) &&
              !mayHoldDocument()
            ) {
              context.report({ node, messageId: "htmlDocument" });
            }
          },
          TemplateLiteral(node) {
            const text = templateText(node);
            if (text !== null && isHtmlDocument(text) && !mayHoldDocument()) {
              context.report({ node, messageId: "htmlDocument" });
            }
          },
          CallExpression(node) {
            if (isWindowClose(node) && !isOwner()) {
              context.report({ node, messageId: "windowClose" });
            }
          },
          JSXElement(node) {
            if (isOwner()) {
              return;
            }
            if (elementName(node) === "Frame" && isMessageCard(node)) {
              context.report({ node, messageId: "messageCard" });
              return;
            }
            if (isHeadedStatusRegion(node)) {
              context.report({ node, messageId: "statusRegion" });
            }
          },
        };
      },
    },
  },
});
