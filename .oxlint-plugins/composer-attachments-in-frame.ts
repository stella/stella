// A composer's draft attachments sit inside its box, above the text and
// outside the text's scroll region. `ComposerFrame` (`@stll/ui/composer-frame`)
// owns that place: its `attachments` slot. Chips mounted anywhere else (in
// the `above` slot, beside the frame, in a wrapper of the surface's own) are
// laid out by the surface, and drift from the chat bar: a tray floating over
// the box, chips scrolling away with the text.
//
// Flagged: `ChatDraftAttachmentChips` anywhere but as the value of a
// `ComposerFrame`'s `attachments` attribute.
//   <ComposerFrame above={<ChatDraftAttachmentChips … />} … />
//   <div className="absolute bottom-full"><ChatDraftAttachmentChips … /></div>
// Allowed:
//   <ComposerFrame attachments={<ChatDraftAttachmentChips … />} … />
//   <ComposerFrame attachments={enabled && <ChatDraftAttachmentChips … />} … />
//
// The slot's value may be the element itself, or the element behind a
// condition (`&&`, `? :`) or a TypeScript wrapper. Anything else between the
// two, a wrapper element or a variable holding the chips, is reported: the
// frame lays the chips out, so nothing else stands between them.
//
// Both components resolve through their imports, so a local component that
// happens to share a name is out of scope. Tests are out of scope too: a
// harness mounts the chips bare to drive them.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import type { AstNode } from "./utils.ts";
import {
  elementName,
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  jsxName,
  TRANSPARENT_WRAPPERS,
} from "./utils.ts";

const RULE_NAME = "composer-attachments-in-frame";
const FRAME_MODULE = "@stll/ui/composer-frame";
const FRAME_EXPORT = "ComposerFrame";
const CHIPS_MODULE = "@/components/chat/chat-draft-attachment-chips";
const CHIPS_EXPORT = "ChatDraftAttachmentChips";
const SLOT_ATTRIBUTE = "attachments";

const isChipsModule = (source: string): boolean =>
  source === CHIPS_MODULE ||
  (source.startsWith(".") &&
    source.replace(/\.tsx?$/u, "").endsWith("/chat-draft-attachment-chips"));

const localNamesOf = (
  program: AstNode,
  matchesSource: (source: string) => boolean,
  imported: string,
): Set<string> => {
  const names = new Set<string>();
  const body = Array.isArray(program.body) ? program.body : [];
  for (const statement of body) {
    if (
      !isAstNode(statement) ||
      statement.type !== "ImportDeclaration" ||
      !isAstNode(statement.source) ||
      typeof statement.source.value !== "string" ||
      !matchesSource(statement.source.value) ||
      !Array.isArray(statement.specifiers)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const local = getImportLocalName(specifier);
      if (getImportedName(specifier) === imported && local !== null) {
        names.add(local);
      }
    }
  }
  return names;
};

// The node a value's position belongs to, past the conditions and wrappers
// that only decide whether it renders.
const slotHolder = (node: AstNode): AstNode | null => {
  let child = node;
  let parent: unknown = node.parent;
  while (isAstNode(parent)) {
    const passesThrough =
      TRANSPARENT_WRAPPERS.has(parent.type) ||
      parent.type === "JSXExpressionContainer" ||
      (parent.type === "LogicalExpression" && parent.right === child) ||
      (parent.type === "ConditionalExpression" && parent.test !== child);
    if (!passesThrough) {
      return parent;
    }
    child = parent;
    parent = parent.parent;
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          outsideFrame:
            "Draft attachment chips go in ComposerFrame's `attachments` slot (@stll/ui/composer-frame), written there directly: the frame keeps them inside the box, above the text and outside its scroll region, the same on every composer.",
        },
        schema: [],
      },
      createOnce(context) {
        let frames = new Set<string>();
        let chips = new Set<string>();
        return {
          Program(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            frames = localNamesOf(
              node,
              (source) => source === FRAME_MODULE,
              FRAME_EXPORT,
            );
            chips = localNamesOf(node, isChipsModule, CHIPS_EXPORT);
          },
          JSXElement(node: unknown) {
            const name = elementName(node);
            if (!isAstNode(node) || name === null || !chips.has(name)) {
              return;
            }
            const holder = slotHolder(node);
            const inSlot =
              holder?.type === "JSXAttribute" &&
              jsxName(holder.name) === SLOT_ATTRIBUTE &&
              isAstNode(holder.parent) &&
              holder.parent.type === "JSXOpeningElement" &&
              frames.has(jsxName(holder.parent.name) ?? "");
            // First-week rollout: only chips on lines this change touched
            // (scripts/guard-rollouts/composer-attachments-in-frame.json).
            if (
              !inSlot &&
              guardEnforcesLine({
                guard: RULE_NAME,
                file: filenameForContext(context),
                line: context.sourceCode.getLocFromIndex(node.range[0]).line,
              })
            ) {
              context.report({ node, messageId: "outsideFrame" });
            }
          },
        };
      },
    },
  },
});
