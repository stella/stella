import type { Transaction } from "@tiptap/pm/state";
import type { Editor, JSONContent } from "@tiptap/react";

/**
 * Transaction meta marking a store->editor echo: the provider applying an
 * already-persisted draft back into the editor (thread switch, restoring the
 * draft after a failed submit). The persist path ignores updates that carry
 * it — an echo re-entering the draft store would churn the stored reference
 * and re-trigger the editor, the update loop React's max-depth guard turns
 * into a crash. The meta rides on the transaction itself, so the suppression
 * survives asynchronous emission orders (ProseMirror's DOMObserver can flush
 * between effects) where a boolean "currently applying" window would leak.
 */
export const CHAT_DRAFT_ECHO_META = "stllChatDraftEcho";

/** Apply a stored draft doc to the editor, tagged as an echo. */
export const applyDraftDocToEditor = (
  editor: Editor,
  doc: JSONContent,
): void => {
  editor.chain().setMeta(CHAT_DRAFT_ECHO_META, true).setContent(doc).run();
};

type MetaCarrier = Pick<Transaction, "getMeta">;

/** Whether any transaction behind a tiptap `update` event is a draft echo. */
export const updateCarriesDraftEcho = (
  transactions: readonly MetaCarrier[],
): boolean =>
  transactions.some(
    (transaction) => transaction.getMeta(CHAT_DRAFT_ECHO_META) === true,
  );
