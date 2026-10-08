/**
 * The one owner of the docked inspector's remembered width.
 *
 * The width is a display preference of this browser, not workspace state, so
 * it is not scoped to the organization and user the tab state is (see
 * `inspector-broadcast.ts`). It is also one preference, not one per section:
 * a reader moving between matters and case law expects the pane to stay the
 * width they dragged it to. Every dock reads and writes it through
 * `useSharedInspectorPaneWidth`, so no surface can grow a key of its own.
 */

import { useState } from "react";

import { useInspectorPaneWidth } from "@stll/ui/inspector";

import { deviceStorage } from "@/lib/account/browser-storage";

export const INSPECTOR_PANE_WIDTH_STORAGE_KEY =
  "stella:inspector-pane-width:v2";

const INSPECTOR_PANE_SURFACES = ["matter", "public-law"] as const;

export type InspectorPaneSurface = (typeof INSPECTOR_PANE_SURFACES)[number];

const LEGACY_SURFACE_STORAGE_KEYS: Record<InspectorPaneSurface, string> = {
  matter: "stella:inspector-pane-width:v1:matter",
  "public-law": "stella:inspector-pane-width:v1:public-law",
};

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
  // Best-effort like every device preference: blocked storage reads as empty
  // and the pane opens at its default width.
  const storage = deviceStorage("local");
  const legacyKeys = [
    LEGACY_SURFACE_STORAGE_KEYS[openedFrom],
    ...INSPECTOR_PANE_SURFACES.filter((surface) => surface !== openedFrom).map(
      (surface) => LEGACY_SURFACE_STORAGE_KEYS[surface],
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
  /** The surface docking the pane; only picks which earlier width migrates. */
  openedFrom: InspectorPaneSurface;
  sidebarWidth: number;
  viewportWidth: number;
};

export const useSharedInspectorPaneWidth = ({
  openedFrom,
  sidebarWidth,
  viewportWidth,
}: UseSharedInspectorPaneWidthOptions) => {
  // Runs before the width hook's own initializer reads the shared key.
  useState(() => {
    migrateInspectorPaneWidth(openedFrom);
    return null;
  });
  return useInspectorPaneWidth({
    sidebarWidth,
    storageKey: INSPECTOR_PANE_WIDTH_STORAGE_KEY,
    viewportWidth,
  });
};
