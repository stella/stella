import * as v from "valibot";

/** The one owner of the docked inspector's remembered width. */
import {
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
  useInspectorPaneWidth,
} from "@stll/ui/inspector";

import {
  definePersistedState,
  keepInAnyScope,
  readPersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";

export const INSPECTOR_PANE_WIDTH_STORAGE_KEY =
  "stella:inspector-pane-width:v2";

export type InspectorPaneSurface = "matter" | "public-law";

const inspectorPaneWidthEntry = definePersistedState({
  key: INSPECTOR_PANE_WIDTH_STORAGE_KEY,
  area: "local",
  version: 1,
  schema: v.pipe(
    v.number(),
    v.minValue(INSPECTOR_PANE_MIN_WIDTH),
    v.maxValue(INSPECTOR_PANE_MAX_WIDTH),
  ),
  maxBytes: 128,
  defaultValue: () => 512,
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

const paneWidthPersistence = {
  read: () => readPersistedState(inspectorPaneWidthEntry, {}),
  write: (width: number) => {
    writePersistedState(inspectorPaneWidthEntry, {}, width).unwrapOr(undefined);
  },
};

type UseSharedInspectorPaneWidthOptions = {
  openedFrom: InspectorPaneSurface;
  sidebarWidth: number;
  viewportWidth: number;
};

export const useSharedInspectorPaneWidth = ({
  openedFrom: _openedFrom,
  sidebarWidth,
  viewportWidth,
}: UseSharedInspectorPaneWidthOptions) =>
  useInspectorPaneWidth({
    persistence: paneWidthPersistence,
    sidebarWidth,
    viewportWidth,
  });
