import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  type DriveChildrenResponse,
  fetchAccountLabel,
  listDriveRootChildren,
  mapDriveChildrenToPage,
} from "@/api/handlers/sharepoint/graph-client";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  type safeOutboundFetchBytes,
  SafeOutboundFetchError,
} from "@/api/lib/safe-outbound-fetch";
import { secretSchema } from "@/api/lib/secret-brands";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

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

test("Graph account and drive reads use pinned outbound transport and byte ceilings", async () => {
  const limits: number[] = [];
  const fetchBytes: typeof safeOutboundFetchBytes = async (input) => {
    limits.push(input.maxBytes);
    expect(input.redirect).toBe("error");
    expect(input.timeoutMs).toBe(10_000);
    const url = new URL(input.url);
    expect(url.hostname).toBe("graph.microsoft.com");
    const value =
      url.pathname === "/v1.0/me"
        ? { userPrincipalName: "person@example.test" }
        : { value: [{ id: "item-1", name: "Folder", folder: {} }] };
    return Result.ok({
      body: new TextEncoder().encode(JSON.stringify(value)).buffer,
      headers: new Headers(),
      ok: true,
      status: 200,
    });
  };
  const permit = grantThirdPartyOutboundPermit();
  expect(
    await fetchAccountLabel({
      accessToken: "access-token",
      fetchBytes,
      permit,
    }),
  ).toEqual(Result.ok("person@example.test"));
  const page = await listDriveRootChildren({
    accessToken: v.parse(secretSchema, "access-token"),
    cursor: null,
    fetchBytes,
    limit: 25,
    permit,
  });
  expect(Result.isOk(page) && page.value.items).toMatchObject([
    { id: "item-1", kind: "folder" },
  ]);
  expect(limits).toEqual([64 * 1024, 2 * 1024 * 1024]);
});

test("an optional account label failure is observed without exposing its provider detail", async () => {
  const logs = installRecordingLogger();
  try {
    const label = await fetchAccountLabel({
      accessToken: "access-token",
      permit: grantThirdPartyOutboundPermit(),
      fetchBytes: async () =>
        Result.err(
          new SafeOutboundFetchError({ message: "private provider detail" }),
        ),
    });
    expect(Result.isError(label)).toBe(true);
    expect(logs.records.map(({ message }) => message)).toContain(
      "sharepoint.account_label_lookup_failed",
    );
    expect(JSON.stringify(logs.records)).not.toContain(
      "private provider detail",
    );
  } finally {
    logs.restore();
  }
});

test("invalid Graph account and drive payloads do not enter telemetry or error causes", async () => {
  const privateText = "privileged-account-label";
  const logs = installRecordingLogger();
  try {
    const label = await fetchAccountLabel({
      accessToken: "access-token",
      permit: grantThirdPartyOutboundPermit(),
      fetchBytes: async () =>
        Result.ok({
          body: new TextEncoder().encode(
            `{"userPrincipalName":"${privateText}"`,
          ).buffer,
          headers: new Headers(),
          ok: true,
          status: 200,
        }),
    });
    expect(Result.isError(label)).toBe(true);
    expect(JSON.stringify(logs.records)).not.toContain(privateText);

    const page = await listDriveRootChildren({
      accessToken: v.parse(secretSchema, "access-token"),
      cursor: null,
      fetchBytes: async () =>
        Result.ok({
          body: new TextEncoder().encode(
            JSON.stringify({ value: [{ id: 123, name: privateText }] }),
          ).buffer,
          headers: new Headers(),
          ok: true,
          status: 200,
        }),
      limit: 25,
      permit: grantThirdPartyOutboundPermit(),
    });
    expect(Result.isError(page)).toBe(true);
    if (Result.isError(page)) {
      expect(page.error.message).toBe("Invalid Microsoft Graph drive response");
      expect(JSON.stringify(page.error)).not.toContain(privateText);
    }
  } finally {
    logs.restore();
  }
});
