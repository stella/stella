// A Copy control confirms in place ("Copied"), and the reader's own copy of
// the same words (Cmd+C, Ctrl+C, the browser's Copy menu) confirms it the same
// way. Two owners hold that contract, so no surface wires half of it:
//
//   - `CopyButton` (`@stll/ui/copy-button`, through the app's
//     `CopyActionButton`) for a fixed value: a message, a code block, a URL, an
//     id. Its press is the only copy of exactly that value, so only the press
//     confirms it.
//   - `useSelectionCopy` (`apps/web/src/components/selection-toolbar-actions.tsx`)
//     for the words a reader selected. It installs the document's `copy`
//     listener itself, so a selection bar cannot render a Copy whose
//     confirmation ignores Cmd+C.
//
// Two rules:
//
// `copy-feedback-owner`: the Copy and Copied swap (`CopyFeedback`) and its
// timer (`useCopiedFeedback`) are imported only by the selection owner; every
// other copy control is a `CopyButton`. The table row lives in
// ./restricted-import.ts.
//
// `no-raw-copy-listener`: nothing but COPY_LISTENER_OWNERS listens for the
// document's `copy` event.
//
// Rejected:
//   document.addEventListener("copy", confirm)  // a DOM listener
//   <div onCopy={confirm} />                     // a JSX handler on an element
//   <div onCopyCapture={confirm} />
//
// Accepted: other events, a component's own `onCopy` prop (`<CopyButton
// onCopy={...} />` names the write it performs, not a DOM event), and a test
// file's synthetic `copy` event. `on<event>` assignment is already rejected
// by `unicorn/prefer-add-event-listener`.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";
import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  staticStringValue,
} from "./utils.ts";

/**
 * The sanctioned `copy` listeners, as repository-relative paths. Add an owner
 * here, with the reason it is one, rather than exempting a caller.
 */
export const COPY_LISTENER_OWNERS: readonly string[] = [
  // Confirms a selection bar's Copy when the reader copies its words.
  "apps/web/src/components/selection-toolbar-actions.tsx",
  // Writes the chat transcript's own clipboard payload for a native copy (the
  // selected words without hidden or excluded chrome). It confirms nothing.
  "apps/web/src/components/chat/chat-transcript-copy.tsx",
];

const isCopyListenerOwner = (filename: string): boolean =>
  COPY_LISTENER_OWNERS.some(
    (owner) => filename === owner || filename.endsWith(`/${owner}`),
  );

const HANDLER_PROPS: ReadonlySet<string> = new Set(["onCopy", "onCopyCapture"]);

const COPY_EVENT = "copy";

/** The static name a member expression reads, or null. */
const memberName = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "MemberExpression") {
    return null;
  }
  return node.computed === true
    ? staticStringValue(node.property)
    : getPropertyName(node.property);
};

/** A lowercase JSX tag is a DOM element; a component's props are its own. */
const isIntrinsicElement = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "JSXOpeningElement" &&
  isAstNode(node.name) &&
  node.name.type === "JSXIdentifier" &&
  typeof node.name.name === "string" &&
  /^[a-z]/u.test(node.name.name);

export default eslintCompatPlugin({
  meta: { name: "copy-feedback-owner" },
  rules: {
    "copy-feedback-owner": {
      meta: restrictedImportMeta("copy-feedback-owner"),
      createOnce(context) {
        return restrictedImportVisitors(context, "copy-feedback-owner");
      },
    },
    "no-raw-copy-listener": {
      meta: {
        type: "problem",
        messages: {
          rawCopyListener:
            "Do not listen for the native `copy` event with `{{name}}`. A " +
            "selection bar's Copy comes from useSelectionCopy " +
            "(@/components/selection-toolbar-actions), which confirms the " +
            "reader's own copy of the selected words; a fixed value's Copy " +
            "is a CopyActionButton, confirmed by its press. A new clipboard " +
            "owner goes in COPY_LISTENER_OWNERS with its reason.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            return !isCopyListenerOwner(filenameForContext(context));
          },
          JSXAttribute(node) {
            if (
              node.name.type === "JSXIdentifier" &&
              HANDLER_PROPS.has(node.name.name) &&
              isIntrinsicElement(node.parent)
            ) {
              context.report({
                node,
                messageId: "rawCopyListener",
                data: { name: node.name.name },
              });
            }
          },
          CallExpression(node) {
            if (
              memberName(node.callee) === "addEventListener" &&
              staticStringValue(node.arguments.at(0)) === COPY_EVENT
            ) {
              context.report({
                node,
                messageId: "rawCopyListener",
                data: { name: `addEventListener("${COPY_EVENT}")` },
              });
            }
          },
        };
      },
    },
  },
});
