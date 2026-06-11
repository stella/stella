/**
 * History Extension — undo/redo via prosemirror-history
 */

import { history, undo, redo } from "prosemirror-history";

import { createExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";

type HistoryOptions = {
  depth: number;
  newGroupDelay: number;
};

const defaultHistoryOptions: HistoryOptions = {
  depth: 100,
  newGroupDelay: 500,
};

export const HistoryExtension = createExtension({
  name: "history",
  defaultOptions: defaultHistoryOptions,
  onSchemaReady(
    _ctx: ExtensionContext,
    options: HistoryOptions,
  ): ExtensionRuntime {
    return {
      plugins: [
        history({
          depth: options.depth,
          newGroupDelay: options.newGroupDelay,
        }),
      ],
      commands: {
        undo: () => undo,
        redo: () => redo,
      },
      keyboardShortcuts: {
        "Mod-z": undo,
        "Mod-y": redo,
        "Mod-Shift-z": redo,
      },
    };
  },
});
