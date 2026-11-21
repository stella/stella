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

const openComposerLink = (view: EditorView, event: MouseEvent) => {
  if (
    event.type === "click"
      ? event.button !== 0 || !(event.metaKey || event.ctrlKey)
      : event.button !== 1
  ) {
    return false;
  }
  if (!(event.target instanceof Element)) {
    return false;
  }
  const anchor = event.target.closest("a[data-chat-composer-link]");
  if (!(anchor instanceof HTMLAnchorElement) || !view.dom.contains(anchor)) {
    return false;
  }
  event.preventDefault();
  window.open(anchor.href, CHAT_LINK_ATTRIBUTES.target, "noopener,noreferrer");
  return true;
};

/** View-only links: saved drafts and submitted HTML retain the original bytes. */
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
                  decorations: current.decorations.map(
                    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ProseMirror DecorationSet.map takes a mapping and document, not an Array thisArg.
                    transaction.mapping,
                    transaction.doc,
                  ),
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
            click: openComposerLink,
            auxclick: openComposerLink,
          },
        },
      }),
    ];
  },
});
