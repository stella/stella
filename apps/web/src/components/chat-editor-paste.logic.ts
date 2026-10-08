import type { Editor, JSONContent } from "@tiptap/core";

import { readDecisionPassage } from "./chat-decision-passage";
import type { DecisionPassage } from "./chat-decision-passage";
import { shouldChipPaste } from "./chat-pasted-text";
import { containsCredentialCandidate } from "./chat-secret-candidate.logic";

type PasteClipboard = {
  getData: DataTransfer["getData"];
  items: Iterable<Pick<DataTransferItem, "kind">>;
};

type ChatPaste =
  | { type: "ignore" }
  | { type: "files" }
  | { type: "decision"; passage: DecisionPassage }
  | { type: "chip"; text: string }
  | { type: "credential" }
  | { type: "text"; content: JSONContent[] };

export type CredentialPasteEditor = Pick<Editor, "isDestroyed"> & {
  commands: { insertContent: (content: string) => boolean };
};

export const insertCredentialPasteRequest = (
  editor: CredentialPasteEditor,
  request: string,
): boolean => {
  if (editor.isDestroyed) {
    return false;
  }
  return editor.commands.insertContent(request);
};

/** Every paste is owned here; HTML must never reach the editor's default parser. */
export const readChatPaste = (clipboard: PasteClipboard | null): ChatPaste => {
  if (clipboard === null) {
    return { type: "ignore" };
  }
  if (Array.from(clipboard.items).some((item) => item.kind === "file")) {
    return { type: "files" };
  }
  const text = clipboard.getData("text/plain");
  if (containsCredentialCandidate(text)) {
    return { type: "credential" };
  }
  const passage = readDecisionPassage(clipboard);
  if (passage !== null) {
    return { type: "decision", passage };
  }
  if (text === "") {
    return { type: "ignore" };
  }
  if (shouldChipPaste(text)) {
    return { type: "chip", text };
  }
  const content: JSONContent[] = [];
  for (const [index, line] of text.split(/\r\n?|\n/u).entries()) {
    if (index > 0) {
      content.push({ type: "hardBreak" });
    }
    if (line !== "") {
      content.push({ type: "text", text: line });
    }
  }
  return { type: "text", content };
};
