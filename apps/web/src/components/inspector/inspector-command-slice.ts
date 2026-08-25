import type {
  InspectorCommandSet,
  InspectorCommandStore,
} from "@/components/inspector/inspector-store-types";

/** Commands that must survive until a lazily mounted consumer acknowledges them. */
export const createInspectorCommandSlice = (
  set: InspectorCommandSet,
): InspectorCommandStore => ({
  desktopOpenAttention: null,
  pendingRenameTabId: null,
  pendingBlockScroll: null,
  pendingPdfPageScroll: null,
  pendingDocxEditTabId: null,
  pendingFileChatDraft: null,

  requestFileChatDraft: ({ fileFieldId, html }) =>
    set((state) => {
      state.pendingFileChatDraft = {
        fileFieldId,
        html,
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
      state.pendingBlockScroll = { tabId, blockId, text };
    }),

  clearPendingBlockScroll: () =>
    set((state) => {
      state.pendingBlockScroll = null;
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
