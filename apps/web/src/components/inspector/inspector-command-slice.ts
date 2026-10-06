import type {
  InspectorCommandSet,
  InspectorCommandStore,
} from "@/components/inspector/inspector-store-types";

/** Pending commands and live actions owned by mounted inspector surfaces. */
export const createInspectorCommandSlice = (
  set: InspectorCommandSet,
): InspectorCommandStore => ({
  newChatCommand: null,
  registerNewChatCommand: ({ tabId, run }) => {
    // Each registration has its own identity so an obsolete cleanup cannot
    // remove the next mounted surface's action, even if it reused the callback.
    const registeredRun = () => run();
    set((state) => {
      state.newChatCommand = { tabId, run: registeredRun };
    });
    return () =>
      set((state) => {
        if (state.newChatCommand?.run === registeredRun) {
          state.newChatCommand = null;
        }
      });
  },
  desktopOpenAttention: null,
  pendingRenameTabId: null,
  pendingBlockScroll: null,
  blockScrollSeq: 0,
  pendingPdfPageScroll: null,
  pendingDocxEditTabId: null,
  pendingFileChatDraft: null,

  requestFileChatDraft: ({ fileFieldId, markdown }) =>
    set((state) => {
      state.pendingFileChatDraft = {
        fileFieldId,
        markdown,
        sequence: (state.pendingFileChatDraft?.sequence ?? 0) + 1,
      };
    }),

  clearFileChatDraft: (sequence) =>
    set((state) => {
      if (state.pendingFileChatDraft?.sequence === sequence) {
        state.pendingFileChatDraft = null;
      }
    }),

  requestDesktopOpenAttention: (fieldId) =>
    set((state) => {
      state.desktopOpenAttention = {
        fieldId,
        sequence: (state.desktopOpenAttention?.sequence ?? 0) + 1,
      };
    }),

  clearDesktopOpenAttention: (sequence) =>
    set((state) => {
      if (state.desktopOpenAttention?.sequence === sequence) {
        state.desktopOpenAttention = null;
      }
    }),

  requestRename: (id) =>
    set((state) => {
      state.pendingRenameTabId = id;
    }),

  clearRenameRequest: () =>
    set((state) => {
      state.pendingRenameTabId = null;
    }),

  requestDocxEdit: (tabId) =>
    set((state) => {
      state.pendingDocxEditTabId = tabId;
    }),

  clearDocxEditRequest: () =>
    set((state) => {
      state.pendingDocxEditTabId = null;
    }),

  requestBlockScroll: ({ tabId, blockId, text }) =>
    set((state) => {
      state.blockScrollSeq += 1;
      state.pendingBlockScroll = {
        tabId,
        blockId,
        text,
        seq: state.blockScrollSeq,
      };
    }),

  clearPendingBlockScroll: (seq) =>
    set((state) => {
      if (state.pendingBlockScroll?.seq === seq) {
        state.pendingBlockScroll = null;
      }
    }),

  requestPdfPageScroll: ({ tabId, pageNumber }) =>
    set((state) => {
      state.pendingPdfPageScroll = { tabId, pageNumber };
    }),

  clearPendingPdfPageScroll: () =>
    set((state) => {
      state.pendingPdfPageScroll = null;
    }),

  clearCommandsForMissingTabs: (tabIds) =>
    set((state) => {
      if (
        state.newChatCommand !== null &&
        !tabIds.has(state.newChatCommand.tabId)
      ) {
        state.newChatCommand = null;
      }
      if (
        state.pendingDocxEditTabId !== null &&
        !tabIds.has(state.pendingDocxEditTabId)
      ) {
        state.pendingDocxEditTabId = null;
      }
      if (
        state.pendingRenameTabId !== null &&
        !tabIds.has(state.pendingRenameTabId)
      ) {
        state.pendingRenameTabId = null;
      }
      if (
        state.pendingBlockScroll !== null &&
        !tabIds.has(state.pendingBlockScroll.tabId)
      ) {
        state.pendingBlockScroll = null;
      }
      if (
        state.pendingPdfPageScroll !== null &&
        !tabIds.has(state.pendingPdfPageScroll.tabId)
      ) {
        state.pendingPdfPageScroll = null;
      }
      if (
        state.desktopOpenAttention !== null &&
        !tabIds.has(state.desktopOpenAttention.fieldId)
      ) {
        state.desktopOpenAttention = null;
      }
      if (
        state.pendingFileChatDraft !== null &&
        !tabIds.has(state.pendingFileChatDraft.fileFieldId)
      ) {
        state.pendingFileChatDraft = null;
      }
    }),
});
