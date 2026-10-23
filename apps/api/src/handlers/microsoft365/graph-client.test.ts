import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import {
  fetchAccountLabel,
  listDriveRootChildren,
  mapDriveChildrenToPage,
  type DriveChildrenResponse,
} from "@/api/lib/auth/microsoft365/graph-client";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { secretSchema } from "@/api/lib/secret-brands";

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

test("Graph account and drive reads parse successful responses and report HTTP failures", async () => {
  const fetch = spyOn(globalThis, "fetch");
  fetch
    .mockResolvedValueOnce(
      Response.json({
        userPrincipalName: "person@example.test",
        displayName: "Person",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        value: [{ id: "item-1", name: "Folder", folder: { childCount: 2 } }],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=next-1",
      }),
    )
    .mockResolvedValueOnce(new Response("", { status: 503 }));

  try {
    const account = await fetchAccountLabel("access-token");
    expect(Result.isOk(account) && account.value).toBe("person@example.test");

    const page = await listDriveRootChildren({
      accessToken: v.parse(secretSchema, "access-token"),
      cursor: null,
      limit: 25,
    });
    expect(Result.isOk(page) && page.value).toMatchObject({
      limit: 25,
      nextCursor: "next-1",
      items: [{ id: "item-1", kind: "folder" }],
    });

    const unavailable = await listDriveRootChildren({
      accessToken: v.parse(secretSchema, "access-token"),
      cursor: null,
      limit: 25,
    });
    expect(Result.isError(unavailable)).toBe(true);
    if (Result.isError(unavailable)) {
      expect(HandlerError.is(unavailable.error)).toBe(true);
      expect(unavailable.error.message).toBe(
        "Microsoft Graph returned HTTP 503",
      );
    }
  } finally {
    fetch.mockRestore();
  }
});
