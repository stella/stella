import { useState } from "react";

import * as v from "valibot";

/** The one owner of the docked inspector's remembered width. */
import {
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
  useInspectorPaneWidth,
} from "@stll/ui/inspector";

import { deviceStorage } from "@/lib/account/browser-storage";
import type { PersistedDeviceUiStateKey } from "@/lib/analytics/web-hang/persisted-ui-state";
import {
  definePersistedState,
  isRestoredStateSafeMode,
  keepInAnyScope,
  readPersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";

export const INSPECTOR_PANE_WIDTH_STORAGE_KEY =
  "stella:inspector-pane-width:v2" satisfies PersistedDeviceUiStateKey;

const paneWidthSchema = v.pipe(
  v.number(),
  v.minValue(INSPECTOR_PANE_MIN_WIDTH),
  v.maxValue(INSPECTOR_PANE_MAX_WIDTH),
);

const inspectorPaneWidthEntry = definePersistedState({
  key: INSPECTOR_PANE_WIDTH_STORAGE_KEY,
  area: "local",
  version: 1,
  schema: paneWidthSchema,
  legacy: { encoding: "json", schema: paneWidthSchema },
  maxBytes: 128,
  defaultValue: () => 512,
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

export const readPersistedInspectorPaneWidth = () =>
  readPersistedState(inspectorPaneWidthEntry, {});

const paneWidthPersistence = {
  read: readPersistedInspectorPaneWidth,
  write: (width: number) => {
    writePersistedState(inspectorPaneWidthEntry, {}, width).unwrapOr(undefined);
  },
};

const LEGACY_SURFACE_STORAGE_KEYS = {
  matter: "stella:inspector-pane-width:v1:matter",
  "public-law": "stella:inspector-pane-width:v1:public-law",
} as const;

export type InspectorPaneSurface = keyof typeof LEGACY_SURFACE_STORAGE_KEYS;

/**
 * Folds the per-surface widths an earlier build stored into the shared one.
 * Stored widths carry no timestamp, so the surface the reader opens first
 * after the update (the one in use now) stands in for the most recent; the
 * other surface's width is the fallback. A shared width already stored wins,
 * and the per-surface keys are removed either way.
 */
export const migrateInspectorPaneWidth = (
  openedFrom: InspectorPaneSurface,
): void => {
  if (isRestoredStateSafeMode()) {
    return;
  }
  // Best-effort like every device preference: blocked storage reads as empty
  // and the pane opens at its default width.
  const storage = deviceStorage("local");
  const legacyKeys = [
    LEGACY_SURFACE_STORAGE_KEYS[openedFrom],
    ...Object.values(LEGACY_SURFACE_STORAGE_KEYS).filter(
      (key) => key !== LEGACY_SURFACE_STORAGE_KEYS[openedFrom],
    ),
  ];
  const legacyWidth = legacyKeys
    .map((key) => storage.getItem(key))
    .find((value) => value !== null);
  if (
    legacyWidth !== undefined &&
    storage.getItem(INSPECTOR_PANE_WIDTH_STORAGE_KEY) === null
  ) {
    storage.setItem(INSPECTOR_PANE_WIDTH_STORAGE_KEY, legacyWidth);
  }
  for (const key of legacyKeys) {
    storage.removeItem(key);
  }
};

type UseSharedInspectorPaneWidthOptions = {
  openedFrom: InspectorPaneSurface;
  sidebarWidth: number;
  viewportWidth: number;
};

export const useSharedInspectorPaneWidth = ({
  openedFrom,
  sidebarWidth,
  viewportWidth,
}: UseSharedInspectorPaneWidthOptions) => {
  useState(() => {
    migrateInspectorPaneWidth(openedFrom);
    return null;
  });
  return useInspectorPaneWidth({
    persistence: paneWidthPersistence,
    sidebarWidth,
    viewportWidth,
  });
};
