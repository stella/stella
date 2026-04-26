/**
 * Selection Tracker Extension — wraps createSelectionTrackerPlugin
 */

import {
  createSelectionTrackerPlugin,
  extractSelectionContext,
} from "../../plugins/selectionTracker";
import type { SelectionChangeCallback } from "../../plugins/selectionTracker";
import { createExtension } from "../create";
import type { ExtensionRuntime } from "../types";

export const SelectionTrackerExtension = createExtension<{
  onSelectionChange?: SelectionChangeCallback;
}>({
  name: "selectionTracker",
  defaultOptions: {},
  onSchemaReady(_ctx, options): ExtensionRuntime {
    return {
      plugins: [createSelectionTrackerPlugin(options.onSelectionChange)],
      commands: {
        extractSelectionContext: () => (state, _dispatch) => {
          extractSelectionContext(state);
          return true;
        },
      },
    };
  },
});
