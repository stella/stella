import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  SHAREPOINT_REFUSAL_CODE,
  SHAREPOINT_ROOT_ITEM_ID,
} from "@stll/api-contract/sharepoint";

import {
  sharepointDriveIdSchema,
  sharepointFolderIdSchema,
  sharepointSiteIdSchema,
} from "@/api/handlers/sharepoint/browse-input";
import {
  cursorFromNextLink,
  downloadSharepointFile,
  type GraphDriveItem,
  graphRefusal,
  listSharepointChildren,
  listSharepointSites,
  parseRetryAfterMs,
  toSharepointDriveItem,
} from "@/api/handlers/sharepoint/graph-client";
import { secretSchema } from "@/api/lib/secret-brands";
import { withTestFetch } from "@/api/tests/helpers/test-fetch";

const accessToken = v.parse(secretSchema, "graph-access-token");

const folder = {
  id: "01FOLDER",
  name: "Contracts",
  webUrl: "https://contoso.sharepoint.com/Contracts",
  eTag: '"{A},1"',
  folder: { childCount: 3 },
  parentReference: { driveId: "b!parentDrive" },
} satisfies GraphDriveItem;

const file = {
  id: "01FILE",
  name: "NDA.docx",
  webUrl: "https://contoso.sharepoint.com/NDA.docx",
  eTag: '"{B},2"',
  size: 2048,
  lastModifiedDateTime: "2026-07-01T10:00:00Z",
  file: { mimeType: "application/vnd.openxmlformats" },
} satisfies GraphDriveItem;

const notebook = {
  id: "01NOTEBOOK",
  name: "Notes",
  package: { type: "oneNote" },
} satisfies GraphDriveItem;

type RecordedRequest = { url: URL; authorization: string | null };

const graphFetch = (
  respond: (url: URL) => Response,
  requests: RecordedRequest[],
): typeof fetch =>
  Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return await Promise.resolve(respond(url));
    },
    { preconnect: globalThis.fetch.preconnect },
  );

describe("drive item mapping", () => {
  test("a folder, a file and a package each get their own kind", () => {
    expect(toSharepointDriveItem(folder, "b!listed").kind).toBe("folder");
    expect(toSharepointDriveItem(file, "b!listed")).toEqual({
      id: "01FILE",
      driveId: "b!listed",
      name: "NDA.docx",
      kind: "file",
      size: 2048,
      mimeType: "application/vnd.openxmlformats",
      lastModifiedAt: "2026-07-01T10:00:00Z",
      webUrl: "https://contoso.sharepoint.com/NDA.docx",
      eTag: '"{B},2"',
    });
    expect(toSharepointDriveItem(notebook, "b!listed").kind).toBe("other");
  });

  test("the item's own drive wins over the listed drive", () => {
    expect(toSharepointDriveItem(folder, "b!listed").driveId).toBe(
      "b!parentDrive",
    );
  });
});

describe("next-page cursor", () => {
  test("keeps only the query string of Graph's next link", () => {
    const cursor = cursorFromNextLink(
      "https://evil.example/v1.0/me/drive/root/children?$top=50&$skiptoken=OPAQUE123",
    );
    expect(cursor.unwrap()).toBe("$top=50&$skiptoken=OPAQUE123");
  });

  test("no next link is the last page", () => {
    expect(cursorFromNextLink(undefined).unwrap()).toBeNull();
  });

  test("a next link without a query cannot be followed and is an upstream error", () => {
    const cursor = cursorFromNextLink(
      "https://graph.microsoft.com/v1.0/me/followedSites",
    );
    expect(Result.isError(cursor)).toBe(true);
  });
});

const pick = ({
  status,
  code,
}: {
  status: number;
  code?: string | undefined;
}) => ({
  status,
  code,
});

describe("Graph refusals", () => {
  const refusal = (status: number, overrides: { cursorSent?: boolean } = {}) =>
    graphRefusal({
      status,
      retryAfter: null,
      cursorSent: overrides.cursorSent ?? false,
    });

  test("each Graph status maps to the client outcome it stands for", () => {
    const cases = [
      [401, 409, SHAREPOINT_REFUSAL_CODE.reconnectRequired],
      [403, 403, SHAREPOINT_REFUSAL_CODE.accessDenied],
      [404, 404, SHAREPOINT_REFUSAL_CODE.notFound],
      [410, 404, SHAREPOINT_REFUSAL_CODE.notFound],
      [429, 429, SHAREPOINT_REFUSAL_CODE.throttled],
      [503, 429, SHAREPOINT_REFUSAL_CODE.throttled],
      [400, 502, "internal_error"],
      [500, 502, "internal_error"],
    ] as const;
    for (const [graphStatus, status, code] of cases) {
      expect({ graphStatus, ...pick(refusal(graphStatus)) }).toEqual({
        graphStatus,
        status,
        code,
      });
    }
  });

  test("a 400 on a cursor page names the cursor", () => {
    expect(pick(refusal(400, { cursorSent: true }))).toEqual({
      status: 400,
      code: SHAREPOINT_REFUSAL_CODE.invalidCursor,
    });
  });

  test("throttling carries Graph's Retry-After as retry advice", () => {
    const throttled = graphRefusal({
      status: 429,
      retryAfter: "7",
      cursorSent: false,
    });
    expect(throttled.retryable).toBe(true);
    expect(throttled.retryAfterMs).toBe(7000);
  });
});

describe("Retry-After", () => {
  test("reads Graph's delta-seconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs(" 12 ")).toBe(12_000);
  });

  test("falls back for a missing, zero or unreadable value and clamps a long one", () => {
    for (const header of [
      null,
      "",
      "0",
      "soon",
      "-4",
      "1.5",
      "Wed, 11 Nov 2026 12:00:09 GMT",
    ]) {
      expect(parseRetryAfterMs(header)).toBe(5000);
    }
    expect(parseRetryAfterMs("86400")).toBe(120_000);
  });
});

describe("Graph ids", () => {
  const schemas = [
    sharepointSiteIdSchema,
    sharepointDriveIdSchema,
    sharepointFolderIdSchema,
  ];

  test("accept the id shapes Graph issues", () => {
    for (const id of [
      "contoso.sharepoint.com,2C712604-1370-44E7-A1F5-426573FDA80A,2D2244C3-251A-49EA-93A8-39E1C3A060FE",
      "b!t18F8ybsHUq1z3LTz8xvZqP8zaSWjkFNhsME-Fepo75dTf9vQKfeRblBZjoSQrd7",
      "D4648F06C91D9D3D!54927",
      SHAREPOINT_ROOT_ITEM_ID,
    ]) {
      for (const schema of schemas) {
        expect(v.is(schema, id)).toBe(true);
      }
    }
  });

  test("reject anything that could leave its URL path segment", () => {
    for (const id of ["..", ".", "a/b", "a?b", "a#b", "a%2fb", "a b", ""]) {
      for (const schema of schemas) {
        expect(v.is(schema, id)).toBe(false);
      }
    }
  });
});

describe("listing through Graph", () => {
  test("a folder listing pages through Graph's next link on the same path", async () => {
    const requests: RecordedRequest[] = [];
    const page = await withTestFetch(
      graphFetch(
        () =>
          Response.json({
            value: [folder, file],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/drives/b!drive/items/01PARENT/children?$skiptoken=NEXT",
          }),
        requests,
      ),
      async () =>
        await listSharepointChildren({
          accessToken,
          driveId: "b!drive",
          itemId: "01PARENT",
          cursor: null,
          limit: 25,
        }),
    );

    const first = requests.at(0);
    expect(first?.url.origin).toBe("https://graph.microsoft.com");
    expect(first?.url.pathname).toBe(
      "/v1.0/drives/b!drive/items/01PARENT/children",
    );
    expect(first?.url.searchParams.get("$top")).toBe("25");
    expect(first?.authorization).toBe("Bearer graph-access-token");
    expect(page.unwrap().nextCursor).toBe("$skiptoken=NEXT");
    expect(page.unwrap().items.map(({ kind }) => kind)).toEqual([
      "folder",
      "file",
    ]);

    await withTestFetch(
      graphFetch(() => Response.json({ value: [] }), requests),
      async () =>
        await listSharepointChildren({
          accessToken,
          driveId: "b!drive",
          itemId: "01PARENT",
          cursor: "$skiptoken=NEXT",
          limit: 25,
        }),
    );
    const second = requests.at(1);
    expect(second?.url.pathname).toBe(
      "/v1.0/drives/b!drive/items/01PARENT/children",
    );
    expect(second?.url.searchParams.get("$skiptoken")).toBe("NEXT");
  });

  test("the root folder lists the drive's top level", async () => {
    const requests: RecordedRequest[] = [];
    await withTestFetch(
      graphFetch(() => Response.json({ value: [] }), requests),
      async () =>
        await listSharepointChildren({
          accessToken,
          driveId: "b!drive",
          itemId: SHAREPOINT_ROOT_ITEM_ID,
          cursor: null,
          limit: 10,
        }),
    );
    expect(requests.at(0)?.url.pathname).toBe(
      "/v1.0/drives/b!drive/root/children",
    );
  });

  test("a search lists sites, no search lists followed sites", async () => {
    const requests: RecordedRequest[] = [];
    const site = {
      id: "contoso.sharepoint.com,1,2",
      displayName: "Litigation",
      webUrl: "https://contoso.sharepoint.com/sites/litigation",
    };
    const fake = graphFetch(() => Response.json({ value: [site] }), requests);
    const searched = await withTestFetch(fake, async () =>
      listSharepointSites({
        accessToken,
        search: "litigation",
        cursor: null,
      }),
    );
    await withTestFetch(fake, async () =>
      listSharepointSites({
        accessToken,
        search: null,
        cursor: null,
      }),
    );

    expect(requests.at(0)?.url.pathname).toBe("/v1.0/sites");
    expect(requests.at(0)?.url.searchParams.get("search")).toBe("litigation");
    expect(requests.at(1)?.url.pathname).toBe("/v1.0/me/followedSites");
    expect(searched.unwrap().items).toEqual([
      {
        id: "contoso.sharepoint.com,1,2",
        name: "Litigation",
        webUrl: "https://contoso.sharepoint.com/sites/litigation",
      },
    ]);
  });

  test("Graph throttling reaches the caller as a retryable 429", async () => {
    const result = await withTestFetch(
      graphFetch(
        () =>
          new Response("{}", { status: 429, headers: { "Retry-After": "4" } }),
        [],
      ),
      async () =>
        await listSharepointChildren({
          accessToken,
          driveId: "b!drive",
          itemId: SHAREPOINT_ROOT_ITEM_ID,
          cursor: null,
          limit: 10,
        }),
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(429);
      expect(result.error.retryAfterMs).toBe(4000);
    }
  });

  test("a body that is not a Graph collection is an upstream error, not an empty page", async () => {
    const result = await withTestFetch(
      graphFetch(() => Response.json({ error: "nope" }), []),
      async () =>
        await listSharepointChildren({
          accessToken,
          driveId: "b!drive",
          itemId: SHAREPOINT_ROOT_ITEM_ID,
          cursor: null,
          limit: 10,
        }),
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(502);
    }
  });
});

describe("downloading a file", () => {
  const download = async (respond: (url: URL) => Response, maxBytes = 1024) => {
    const requests: RecordedRequest[] = [];
    const result = await withTestFetch(
      graphFetch(respond, requests),
      async () =>
        await downloadSharepointFile({
          accessToken,
          driveId: "b!drive",
          itemId: "01FILE",
          maxBytes,
        }),
    );
    return { requests, result };
  };

  test("follows Graph's redirect without sending the bearer token on", async () => {
    const { requests, result } = await download((url) =>
      url.hostname === "graph.microsoft.com"
        ? new Response(null, {
            status: 302,
            headers: {
              Location:
                "https://contoso.sharepoint.com/download.aspx?tempauth=x",
            },
          })
        : new Response("file bytes"),
    );

    expect(new TextDecoder().decode(result.unwrap())).toBe("file bytes");
    expect(
      requests.map(({ url, authorization }) => [url.host, authorization]),
    ).toEqual([
      ["graph.microsoft.com", "Bearer graph-access-token"],
      ["contoso.sharepoint.com", null],
    ]);
    expect(requests.at(0)?.url.pathname).toBe(
      "/v1.0/drives/b!drive/items/01FILE/content",
    );
  });

  test("follows a download link only over HTTPS to a Microsoft file host", async () => {
    for (const location of [
      "http://contoso.sharepoint.com/download.aspx",
      "https://contoso.sharepoint.com:8443/download.aspx",
      "https://evil.example/download.aspx",
      "https://sharepoint.com.evil.example/download.aspx",
      "https://169.254.169.254/latest/meta-data",
      "not a url",
    ]) {
      const { requests, result } = await download(
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: location },
          }),
      );
      expect({ location, refused: Result.isError(result) }).toEqual({
        location,
        refused: true,
      });
      expect(requests).toHaveLength(1);
    }
  });

  test("a body over the size limit fails instead of truncating", async () => {
    const { result } = await download(
      () => new Response(new Uint8Array(2048)),
      1024,
    );
    expect(Result.isError(result)).toBe(true);
  });
});
