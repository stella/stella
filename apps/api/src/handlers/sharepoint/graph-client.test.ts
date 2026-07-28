import { describe, expect, test } from "bun:test";

import {
  mapDriveChildrenToPage,
  type DriveChildrenResponse,
} from "@/api/handlers/sharepoint/graph-client";

const folder = {
  id: "01FOLDER",
  name: "Contracts",
  webUrl: "https://contoso.sharepoint.com/Contracts",
  eTag: '"{A},1"',
  folder: { childCount: 3 },
};

const file = {
  id: "01FILE",
  name: "NDA.docx",
  webUrl: "https://contoso.sharepoint.com/NDA.docx",
  eTag: '"{B},2"',
  size: 2048,
  lastModifiedDateTime: "2026-07-01T10:00:00Z",
  file: { mimeType: "application/vnd.openxmlformats" },
};

describe("mapDriveChildrenToPage", () => {
  test("maps items and extracts the skiptoken from @odata.nextLink", () => {
    const response: DriveChildrenResponse = {
      value: [folder, file],
      "@odata.nextLink":
        "https://graph.microsoft.com/v1.0/me/drive/root/children?$top=50&$skiptoken=OPAQUE123",
    };

    const page = mapDriveChildrenToPage(response, 50);

    expect(page.limit).toBe(50);
    expect(page.nextCursor).toBe("OPAQUE123");
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ id: "01FOLDER", kind: "folder" });
    expect(page.items[1]).toMatchObject({
      id: "01FILE",
      kind: "file",
      mimeType: "application/vnd.openxmlformats",
      size: 2048,
    });
  });

  test("nextCursor is null when Graph returns no nextLink (last page)", () => {
    const response: DriveChildrenResponse = { value: [file] };
    const page = mapDriveChildrenToPage(response, 50);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
  });

  test("nextCursor is null when nextLink carries no skiptoken", () => {
    const response: DriveChildrenResponse = {
      value: [],
      "@odata.nextLink":
        "https://graph.microsoft.com/v1.0/me/drive/root/children",
    };
    expect(mapDriveChildrenToPage(response, 25).nextCursor).toBeNull();
  });
});
