import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
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
  track: (reportExport: Omit<TrackedReportExport, "trackedAt">) => void;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const toastIds = new Map<string, string>();

export const useReportExportTrackingStore = create<ReportExportTrackingStore>()(
  persist(
    (set) => ({
      exports: {},
      finish: (exportId) => {
        set((state) => {
          const exports = { ...state.exports };
          delete exports[exportId];
          return { exports };
        });
      },
      track: (reportExport) => {
        set((state) => {
          const trackedAt = nextTrackedAt(state.exports, Date.now());
          return {
            exports: retainNewestTrackedExports([
              ...Object.values(state.exports),
              { ...reportExport, trackedAt },
            ]),
          };
        });
      },
    }),
    {
      name: "stella.report-exports.active",
      partialize: ({ exports }) => ({ exports }),
      version: 1,
      merge: (persisted, current) => ({
        ...current,
        exports: readTrackedExports(persisted),
      }),
    },
  ),
);

export const registerReportExportToast = (
  exportId: string,
  toastId: string,
) => {
  toastIds.set(exportId, toastId);
};

export const takeReportExportToast = (exportId: string) => {
  const toastId = toastIds.get(exportId);
  toastIds.delete(exportId);
  return toastId;
};

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
    "trackedAt" in value &&
    typeof value.trackedAt === "number" &&
    Number.isFinite(value.trackedAt)
  );
};
