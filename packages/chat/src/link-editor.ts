import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { panic } from "better-result";

import { CHAT_LINK_ATTRIBUTES, CHAT_LINK_CLASS_NAME } from "./link";
import { detectChatLinks } from "./link-detection";

const chatLinkPluginKey = new PluginKey<LinkEditorState>("stllChatLinks");

type LinkEditorState = {
  status: "ready" | "composing";
  decorations: DecorationSet;
};

const decorateChatLinks = (doc: ProseMirrorNode) => {
  const decorations: Decoration[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) {
      return true;
    }
    // Leaf placeholders keep positions aligned while preventing links from
    // crossing a mention or pasted-text atom. Mark boundaries remain transparent.
    const text = node.textBetween(0, node.content.size, "\n", "\n");
    for (const link of detectChatLinks(text)) {
      decorations.push(
        Decoration.inline(position + 1 + link.start, position + 1 + link.end, {
          nodeName: "a",
          href: link.href,
          ...CHAT_LINK_ATTRIBUTES,
          class: CHAT_LINK_CLASS_NAME,
          "data-chat-composer-link": "",
          dir: "auto",
        }),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
};

/** View-only links: saved drafts and submitted HTML retain the original bytes. */
const composerLinkAt = (
  view: EditorView,
  event: MouseEvent,
): HTMLAnchorElement | null => {
  if (!(event.target instanceof Element)) {
    return null;
  }
  const anchor = event.target.closest("a[data-chat-composer-link]");
  return anchor instanceof HTMLAnchorElement && view.dom.contains(anchor)
    ? anchor
    : null;
};

// The composer is editable: a plain click only places the caret (the anchor
// never navigates the page), while a modifier or middle click opens the link.
const handleComposerLinkClick = (
  view: EditorView,
  event: MouseEvent,
  opens: boolean,
): boolean => {
  const anchor = composerLinkAt(view, event);
  if (anchor === null) {
    return false;
  }
  event.preventDefault();
  if (!opens) {
    return false;
  }
  window.open(anchor.href, CHAT_LINK_ATTRIBUTES.target, "noopener,noreferrer");
  return true;
};

export const ChatComposerLinks = Extension.create({
  name: "stllChatComposerLinks",
  addProseMirrorPlugins() {
    return [
      new Plugin<LinkEditorState>({
        key: chatLinkPluginKey,
        state: {
          init: (_, state) => ({
            status: "ready",
            decorations: decorateChatLinks(state.doc),
          }),
          apply: (transaction, current) => {
            const requestedStatus: unknown =
              transaction.getMeta(chatLinkPluginKey);
            const status =
              requestedStatus === "ready" || requestedStatus === "composing"
                ? requestedStatus
                : current.status;
            if (
              !transaction.docChanged &&
              requestedStatus !== "ready" &&
              requestedStatus !== "composing"
            ) {
              return current;
            }
            switch (status) {
              case "composing":
                return {
                  status: "composing",
                  /* oxlint-disable unicorn/no-array-method-this-argument -- ProseMirror DecorationSet.map takes a mapping and document, not an Array thisArg. */
                  decorations: current.decorations.map(
                    transaction.mapping,
                    transaction.doc,
                  ),
                  /* oxlint-enable unicorn/no-array-method-this-argument */
                };
              case "ready":
                return {
                  status: "ready",
                  decorations: decorateChatLinks(transaction.doc),
                };
              default:
                status satisfies never;
                return panic("Unhandled composer link status");
            }
          },
        },
        props: {
          decorations: (state) =>
            chatLinkPluginKey.getState(state)?.decorations,
          handleDOMEvents: {
            compositionstart: (view) => {
              view.dispatch(
                view.state.tr.setMeta(chatLinkPluginKey, "composing"),
              );
              return false;
            },
            compositionend: (view) => {
              // Let ProseMirror commit its final composition mutation first.
              queueMicrotask(() => {
                if (!view.isDestroyed) {
                  view.dispatch(
                    view.state.tr.setMeta(chatLinkPluginKey, "ready"),
                  );
                }
              });
              return false;
            },
            click: (view, event) =>
              handleComposerLinkClick(
                view,
                event,
                event.metaKey || event.ctrlKey,
              ),
            auxclick: (view, event) =>
              handleComposerLinkClick(view, event, event.button === 1),
          },
        },
      }),
    ];
  },
});
