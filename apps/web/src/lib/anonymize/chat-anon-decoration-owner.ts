import type { EditorView } from "@tiptap/pm/view";

import type { ChatAnonPair } from "@stll/anonymize-chat";

import { setChatAnonDecorationPairs } from "@/components/chat/chat-anon-decorations-plugin";

type ChatAnonDecorationEditor = {
  view: EditorView;
};

type SetActiveChatAnonDecorationOwnerOptions = {
  editor: ChatAnonDecorationEditor;
  ownerKey: string;
  pairs: readonly ChatAnonPair[];
};

type ChatAnonDecorationWriter<TEditor extends object> = (
  editor: TEditor,
  pairs: readonly ChatAnonPair[],
) => void;

type ChatAnonDecorationOwner<TEditor extends object> = {
  clear: ({
    editor,
    ownerKey,
  }: Omit<
    { editor: TEditor; ownerKey: string; pairs: readonly ChatAnonPair[] },
    "pairs"
  >) => void;
  setActive: ({
    editor,
    ownerKey,
    pairs,
  }: {
    editor: TEditor;
    ownerKey: string;
    pairs: readonly ChatAnonPair[];
  }) => void;
  updateActive: ({
    editor,
    ownerKey,
    pairs,
  }: {
    editor: TEditor;
    ownerKey: string;
    pairs: readonly ChatAnonPair[];
  }) => void;
};

export const createChatAnonDecorationOwner = <TEditor extends object>(
  writePairs: ChatAnonDecorationWriter<TEditor>,
): ChatAnonDecorationOwner<TEditor> => {
  const activeOwnerByEditor = new WeakMap<TEditor, string>();

  return {
    setActive: ({ editor, ownerKey, pairs }) => {
      activeOwnerByEditor.set(editor, ownerKey);
      writePairs(editor, pairs);
    },
    updateActive: ({ editor, ownerKey, pairs }) => {
      if (activeOwnerByEditor.get(editor) !== ownerKey) {
        return;
      }
      writePairs(editor, pairs);
    },
    clear: ({ editor, ownerKey }) => {
      if (activeOwnerByEditor.get(editor) !== ownerKey) {
        return;
      }
      activeOwnerByEditor.delete(editor);
      writePairs(editor, []);
    },
  };
};

const chatAnonDecorationOwner = createChatAnonDecorationOwner(
  (editor: ChatAnonDecorationEditor, pairs) => {
    setChatAnonDecorationPairs(editor.view, pairs);
  },
);

/**
 * Decorations belong to the composer that owns keyboard focus, not simply to
 * whichever mounted chat happens to be anonymized. This is essential when a
 * raw main chat and anonymized inspector share an editor during a transition.
 */
export const setActiveChatAnonDecorationOwner = ({
  editor,
  ownerKey,
  pairs,
}: SetActiveChatAnonDecorationOwnerOptions): void => {
  chatAnonDecorationOwner.setActive({ editor, ownerKey, pairs });
};

/** Ignore stale worker results from a composer that no longer owns the editor. */
export const updateActiveChatAnonDecorationOwner = ({
  editor,
  ownerKey,
  pairs,
}: SetActiveChatAnonDecorationOwnerOptions): void => {
  chatAnonDecorationOwner.updateActive({ editor, ownerKey, pairs });
};

export const clearChatAnonDecorationOwner = ({
  editor,
  ownerKey,
}: Omit<SetActiveChatAnonDecorationOwnerOptions, "pairs">): void => {
  chatAnonDecorationOwner.clear({ editor, ownerKey });
};
