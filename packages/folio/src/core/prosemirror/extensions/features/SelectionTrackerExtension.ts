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

type SelectionTrackerOptions = {
  onSelectionChange?: SelectionChangeCallback;
};

const defaultSelectionTrackerOptions: SelectionTrackerOptions = {};

export const SelectionTrackerExtension = createExtension({
  name: "selectionTracker",
  defaultOptions: defaultSelectionTrackerOptions,
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
