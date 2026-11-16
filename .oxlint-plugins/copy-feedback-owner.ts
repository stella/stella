// Every Copy in the app goes through one owner,
// `apps/web/src/components/copy-control.tsx`: it writes the clipboard, holds
// the one native `copy` listener, and renders the Copy and Copied swap. A Copy
// confirms when the clipboard holds exactly what it copies: on its press, and
// on the reader's own copy (Cmd+C, Ctrl+C, the browser's Copy menu) when that
// leaves exactly its payload there. A surface that wrote the clipboard or
// rendered the swap itself would confirm half of that, or none.
//
// Three rules:
//
// `copy-feedback-owner`: the clipboard helpers (`@stll/clipboard`) and the
// copy feedback primitives of `@stll/ui/copy-button` (`CopyButton`,
// `useCopyConfirmation`, `CopyFeedback`, `useCopiedFeedback`) are imported
// only by the owner. The table rows live in ./restricted-import.ts.
//
// `no-raw-copy-listener`: nothing but COPY_LISTENER_OWNERS listens for the
// `copy` event.
//   Rejected: `document.addEventListener("copy", …)`, `<div onCopy={…} />`,
//   `<div onCopyCapture={…} />`.
//   Accepted: other events, a component's own `onCopy` prop (it names a write
//   the component performs, not a DOM event), and a test file's synthetic
//   `copy` event. `on<event>` assignment is already rejected by
//   `unicorn/prefer-add-event-listener`.
//
// `no-raw-clipboard-write`: nothing but CLIPBOARD_WRITE_OWNERS reaches the
// browser clipboard.
//   Rejected: `navigator.clipboard` (also through `window.navigator`,
//   `globalThis.navigator`, `navigator["clipboard"]` or
//   `Reflect.get(navigator, "clipboard")`), `document.execCommand("copy")`
//   or `"cut"`, and `new ClipboardItem(…)`.
//   Accepted: reading a paste (`event.clipboardData`) and other
//   `execCommand` commands.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";

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

const COPY_CONTROL_OWNER = "apps/web/src/components/copy-control.tsx";

/**
 * The sanctioned `copy` listeners, as repository-relative paths. Add an owner
 * here, with the reason it is one, rather than exempting a caller.
 */
export const COPY_LISTENER_OWNERS: readonly string[] = [
  // Confirms every Copy whose payload a native copy put on the clipboard.
  COPY_CONTROL_OWNER,
  // Writes the chat transcript's own clipboard payload for a native copy (the
  // selected words without hidden or excluded chrome). It confirms nothing.
  "apps/web/src/components/chat/chat-transcript-copy.tsx",
];

/** The sanctioned clipboard writers, as repository-relative paths. */
export const CLIPBOARD_WRITE_OWNERS: readonly string[] = [COPY_CONTROL_OWNER];

const isOwner =
  (owners: readonly string[]) =>
  (filename: string): boolean =>
    owners.some(
      (owner) => filename === owner || filename.endsWith(`/${owner}`),
    );

const HANDLER_PROPS: ReadonlySet<string> = new Set(["onCopy", "onCopyCapture"]);

const COPY_EVENT = "copy";

const CLIPBOARD_COMMANDS: ReadonlySet<string> = new Set(["copy", "cut"]);

const NAVIGATOR_HOSTS: ReadonlySet<string> = new Set([
  "globalThis",
  "self",
  "window",
]);

/** The static name a member expression reads, or null. */
const memberName = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "MemberExpression") {
    return null;
  }
  return node.computed === true
    ? staticStringValue(node.property)
    : getPropertyName(node.property);
};

/** `navigator`, `window.navigator`, `globalThis.navigator`, `self.navigator`. */
const isNavigator = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (node.type === "Identifier") {
    return node.name === "navigator";
  }
  return (
    memberName(node) === "navigator" &&
    isAstNode(node.object) &&
    node.object.type === "Identifier" &&
    typeof node.object.name === "string" &&
    NAVIGATOR_HOSTS.has(node.object.name)
  );
};

/** A lowercase JSX tag is a DOM element; a component's props are its own. */
const isIntrinsicElement = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "JSXOpeningElement" &&
  isAstNode(node.name) &&
  node.name.type === "JSXIdentifier" &&
  typeof node.name.name === "string" &&
  /^[a-z]/u.test(node.name.name);

const isReflectGet = (callee: unknown): boolean =>
  isAstNode(callee) &&
  callee.type === "MemberExpression" &&
  isAstNode(callee.object) &&
  callee.object.type === "Identifier" &&
  callee.object.name === "Reflect" &&
  memberName(callee) === "get";

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
            "Do not listen for the native `copy` event with `{{name}}`. " +
            "Every Copy goes through @/components/copy-control, which holds " +
            "the one listener and confirms each Copy whose payload the " +
            "reader's own copy put on the clipboard. A surface that rewrites " +
            "the copied payload goes in COPY_LISTENER_OWNERS with its reason.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            return !isOwner(COPY_LISTENER_OWNERS)(filenameForContext(context));
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
    "no-raw-clipboard-write": {
      meta: {
        type: "problem",
        messages: {
          rawClipboardWrite:
            "Do not write the clipboard with `{{name}}`. Copy through " +
            "CopyControl, useCopyControl or useSelectionCopyControl " +
            "(@/components/copy-control): the owner reports a failed copy " +
            "and confirms the Copy when the clipboard holds what it copies.",
        },
        schema: [],
      },
      createOnce(context) {
        const report = (node: Ranged, name: string) =>
          context.report({
            node,
            messageId: "rawClipboardWrite",
            data: { name },
          });
        return {
          before() {
            return !isOwner(CLIPBOARD_WRITE_OWNERS)(
              filenameForContext(context),
            );
          },
          MemberExpression(node) {
            if (memberName(node) === "clipboard" && isNavigator(node.object)) {
              report(node, "navigator.clipboard");
            }
          },
          CallExpression(node) {
            const command = staticStringValue(node.arguments.at(0));
            if (
              memberName(node.callee) === "execCommand" &&
              command !== null &&
              CLIPBOARD_COMMANDS.has(command)
            ) {
              report(node, `execCommand("${command}")`);
              return;
            }
            if (
              isReflectGet(node.callee) &&
              isNavigator(node.arguments.at(0)) &&
              staticStringValue(node.arguments.at(1)) === "clipboard"
            ) {
              report(node, 'Reflect.get(navigator, "clipboard")');
            }
          },
          NewExpression(node) {
            if (
              node.callee.type === "Identifier" &&
              node.callee.name === "ClipboardItem"
            ) {
              report(node, "new ClipboardItem()");
            }
          },
        };
      },
    },
  },
});
