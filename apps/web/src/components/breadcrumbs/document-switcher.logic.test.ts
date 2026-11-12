import { describe, expect, it, mock } from "bun:test";

import {
  isCurrentDocument,
  RENDITION_LIST_VIEW,
} from "@/components/breadcrumbs/document-switcher.logic";
import { getPrimaryDownloadVariant } from "@/components/inspector/file-download-service.logic";
import type { DownloadRendition } from "@/components/inspector/file-download-service.logic";
import { queryView } from "@/lib/query-view.logic";

describe("current document selection", () => {
  it("requires both entity and field identity", () => {
    const current = { entityId: "document", fieldId: "original" };
    for (const entityId of ["document", "other"]) {
      for (const fieldId of ["original", "attachment"]) {
        expect(isCurrentDocument({ entityId, fieldId }, current)).toBe(
          entityId === "document" && fieldId === "original",
        );
      }
    }
  });
});

describe("current document download", () => {
  it("downloads the original of a file with no alternative renditions", () => {
    const refetch = mock(async () => {
      throw new Error("not refetched");
    });
    const renditions: DownloadRendition[] = [];
    const view = queryView(
      {
        status: "success",
        fetchStatus: "idle",
        isPlaceholderData: false,
        data: renditions,
        error: null,
        refetch,
      },
      RENDITION_LIST_VIEW,
    );

    expect(view.type).toBe("items");
    if (view.type === "items") {
      expect(getPrimaryDownloadVariant(view.items)).toBe("original");
    }
  });
});
