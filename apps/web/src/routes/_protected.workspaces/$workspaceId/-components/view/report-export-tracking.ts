import { create } from "zustand";
import { persist } from "zustand/middleware";

import { stellaToast } from "@stll/ui/components/toast";

import {
  evictedTrackedExportIds,
  nextTrackedAt,
  retainNewestTrackedExports,
} from "./report-export-tracking.logic";
import type {
  ReportExportDeliveryMode,
  TrackedReportExport,
} from "./report-export-tracking.logic";

export type { ReportExportDeliveryMode, TrackedReportExport };

type ReportExportTrackingStore = {
  exports: Record<string, TrackedReportExport>;
  finish: (exportId: string) => void;
  registerToast: (exportId: string, toastId: string) => void;
  takeToast: (exportId: string) => string | undefined;
  track: (reportExport: Omit<TrackedReportExport, "trackedAt">) => void;
  toastIds: Record<string, string>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_USER_ID_LENGTH = 128;

export const useReportExportTrackingStore = create<ReportExportTrackingStore>()(
  persist(
    (set, get) => ({
      exports: {},
      finish: (exportId) => {
        set((state) => {
          const { [exportId]: finishedExport, ...exports } = state.exports;
          return finishedExport === undefined
            ? { exports: state.exports }
            : { exports };
        });
      },
      registerToast: (exportId, toastId) => {
        set((state) => ({
          toastIds: { ...state.toastIds, [exportId]: toastId },
        }));
      },
      takeToast: (exportId) => {
        const { [exportId]: toastId, ...toastIds } = get().toastIds;
        set({ toastIds });
        return toastId;
      },
      track: (reportExport) => {
        set((state) => {
          const trackedAt = nextTrackedAt(state.exports, Date.now());
          const exports = retainNewestTrackedExports([
            ...Object.values(state.exports),
            { ...reportExport, trackedAt },
          ]);
          const toastIds = dismissEvictedToasts(
            state.toastIds,
            evictedTrackedExportIds(state.exports, exports),
          );
          return { exports, toastIds };
        });
      },
      toastIds: {},
    }),
    {
      name: "stella.report-exports.active",
      partialize: ({ exports }) => ({ exports }),
      version: 2,
      merge: (persisted, current) => ({
        ...current,
        exports: readTrackedExports(persisted),
      }),
    },
  ),
);

/** Evicting a tracked export (the 100-slot cap) drops its state before the
 * tracker ever observes it settle, so its loading toast would otherwise
 * never resolve. Dismiss and forget those toasts here instead. */
const dismissEvictedToasts = (
  toastIds: Record<string, string>,
  exportIds: string[],
): Record<string, string> => {
  let remainingToastIds = toastIds;
  for (const exportId of exportIds) {
    const toastId = remainingToastIds[exportId];
    if (toastId === undefined) {
      continue;
    }
    stellaToast.dismiss(toastId);
    const { [exportId]: _removed, ...rest } = remainingToastIds;
    remainingToastIds = rest;
  }
  return remainingToastIds;
};

export const registerReportExportToast = (
  exportId: string,
  toastId: string,
) => {
  useReportExportTrackingStore.getState().registerToast(exportId, toastId);
};

export const takeReportExportToast = (exportId: string) =>
  useReportExportTrackingStore.getState().takeToast(exportId);

const readTrackedExports = (
  persisted: unknown,
): Record<string, TrackedReportExport> => {
  if (
    typeof persisted !== "object" ||
    persisted === null ||
    !("exports" in persisted) ||
    typeof persisted.exports !== "object" ||
    persisted.exports === null
  ) {
    return {};
  }

  return retainNewestTrackedExports(
    Object.values(persisted.exports).filter(isTrackedReportExport),
  );
};

const isTrackedReportExport = (
  value: unknown,
): value is TrackedReportExport => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    "exportId" in value &&
    typeof value.exportId === "string" &&
    UUID_PATTERN.test(value.exportId) &&
    "workspaceId" in value &&
    typeof value.workspaceId === "string" &&
    UUID_PATTERN.test(value.workspaceId) &&
    "mode" in value &&
    (value.mode === "workspace" || value.mode === "download") &&
    "requestedBy" in value &&
    typeof value.requestedBy === "string" &&
    value.requestedBy.length > 0 &&
    value.requestedBy.length <= MAX_USER_ID_LENGTH &&
    "trackedAt" in value &&
    typeof value.trackedAt === "number" &&
    Number.isFinite(value.trackedAt)
  );
};
