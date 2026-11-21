import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import { installUserScopedStorage } from "@/lib/account/install-user-scoped-storage";
import { releaseUserStorage } from "@/lib/account/user-scoped-storage";

import { useReportExportTrackingStore } from "./report-export-tracking";

const reportExport = {
  exportId: "ad7cf875-c229-484b-a095-15134f0069db",
  workspaceId: "c4fb9240-7843-440b-890e-7cb5cdd7ef8a",
  mode: "download",
  requestedBy: "user-a",
} as const;

test("export tracking accepts the current requester across account transitions", () => {
  const queryClient = new QueryClient();
  const areas = () => ({ local: null, session: null });
  const unsubscribe = installUserScopedStorage(queryClient, areas);
  try {
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    useReportExportTrackingStore.getState().track(reportExport);
    expect(
      Object.keys(useReportExportTrackingStore.getState().exports),
    ).toEqual([reportExport.exportId]);
    queryClient.setQueryData(["session"], { user: { id: "user-b" } });
    useReportExportTrackingStore.getState().track(reportExport);
    expect(useReportExportTrackingStore.getState().exports).toEqual({});
    useReportExportTrackingStore.getState().track({
      ...reportExport,
      requestedBy: "user-b",
    });
    expect(
      useReportExportTrackingStore.getState().exports[reportExport.exportId]
        ?.requestedBy,
    ).toBe("user-b");
    releaseUserStorage(areas());
    useReportExportTrackingStore.getState().track(reportExport);
    expect(useReportExportTrackingStore.getState().exports).toEqual({});
  } finally {
    unsubscribe();
    releaseUserStorage(areas());
    queryClient.clear();
  }
});
