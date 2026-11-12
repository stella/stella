import { Result } from "better-result";
/**
 * Delegated, read-only Microsoft Graph client for the SharePoint connection.
 *
 *   1. `ensureSharepointAccessToken` — return a usable access token,
 *      refreshing it when expired and persisting the rotated tokens. On any
 *      refresh failure the connection is marked `reconnect_required` and the
 *      failure is surfaced (never swallowed), so a stale token can never be
 *      used silently.
 *   2. Browsing: followed or searched sites, drives (the caller's own and a
 *      site's document libraries) and a folder's children, each mapped from
 *      Graph's `@odata.nextLink` pagination into a cursor page.
 *
 * There is no write path and no background sync here.
 */
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { SHAREPOINT_REFUSAL_CODE } from "@stll/api-contract/sharepoint";
import { fetchWithTimeout } from "@stll/fetch";
import {
  BodyByteLimitError,
  readBodyJsonWithIdleDeadline,
  readBodyWithIdleDeadline,
} from "@stll/fetch/body-reader";
import { Temporal } from "@stll/time";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { sharepointConnections } from "@/api/db/schema";
import type { SharepointConnectionStatus } from "@/api/db/schema";
import {
  decryptSharepointSecret,
  encryptSharepointSecret,
} from "@/api/handlers/sharepoint/crypto";
import {
  getSharepointOAuthConfig,
  refreshAccessToken,
  tokenExpiresAt,
} from "@/api/handlers/sharepoint/graph-oauth";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { Page } from "@/api/lib/pagination";
import type { AccessToken } from "@/api/lib/secret-brands";

const GRAPH_FETCH_TIMEOUT_MS = 10_000;
const GRAPH_API_BASE_URL = "https://graph.microsoft.com/v1.0";
// Refresh a little early so a token does not expire mid-request.
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/** Columns `ensureSharepointAccessToken` needs from a connection row. */
export type SharepointConnectionTokens = {
  id: SafeId<"sharepointConnection">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  accessTokenEncrypted: Buffer;
  accessTokenIv: Buffer;
  refreshTokenEncrypted: Buffer | null;
  refreshTokenIv: Buffer | null;
  expiresAt: Date | null;
  status: SharepointConnectionStatus;
};

const reconnectRequiredError = (): HandlerError<409> =>
  new HandlerError({
    status: 409,
    code: SHAREPOINT_REFUSAL_CODE.reconnectRequired,
    message: "SharePoint connection must be reconnected",
    hint: "Reconnect the Microsoft account in stella's SharePoint settings.",
  });

/**
 * Flags the connection for reconnect, but only while it still holds the
 * access token the failing call used: a reconnect that replaced the tokens in
 * the meantime must not be undone by a late failure of the old grant.
 */
export const markReconnectRequired = async ({
  connection,
  safeDb,
}: {
  connection: SharepointConnectionTokens;
  safeDb: SafeDb;
}): Promise<Result<void, SafeDbError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — token-refresh bookkeeping: flags the connection as
        // needing reconnect. The user-facing lifecycle events (connect /
        // disconnect / org-disable purge) are the audited surface.
        await tx
          .update(sharepointConnections)
          .set({ status: "reconnect_required", updatedAt: new Date() })
          .where(
            and(
              eq(sharepointConnections.id, connection.id),
              eq(
                sharepointConnections.organizationId,
                connection.organizationId,
              ),
              eq(sharepointConnections.userId, connection.userId),
              eq(sharepointConnections.accessTokenIv, connection.accessTokenIv),
            ),
          );
      }),
    );
    return Result.ok(undefined);
  });

/** A usable token and the IV it is stored under, which names that grant. */
type UsableSharepointToken = {
  accessToken: AccessToken;
  accessTokenIv: Buffer;
};

export const ensureSharepointAccessToken = async ({
  connection,
  safeDb,
}: {
  connection: SharepointConnectionTokens;
  safeDb: SafeDb;
}): Promise<
  Result<UsableSharepointToken, HandlerError<409 | 500 | 502> | SafeDbError>
> =>
  await Result.gen(async function* () {
    const stillValid =
      connection.status === "connected" &&
      connection.expiresAt !== null &&
      connection.expiresAt.getTime() -
        Temporal.Now.instant().epochMilliseconds >
        TOKEN_EXPIRY_BUFFER_MS;

    if (stillValid) {
      const accessToken = await decryptSharepointSecret({
        purpose: "sharepoint_access_token",
        ciphertext: connection.accessTokenEncrypted,
        iv: connection.accessTokenIv,
        organizationId: connection.organizationId,
        userId: connection.userId,
      });
      return Result.ok({
        accessToken,
        accessTokenIv: connection.accessTokenIv,
      });
    }

    if (!connection.refreshTokenEncrypted || !connection.refreshTokenIv) {
      yield* Result.await(markReconnectRequired({ connection, safeDb }));
      return Result.err(reconnectRequiredError());
    }

    const config = getSharepointOAuthConfig();
    if (Result.isError(config)) {
      return Result.err(config.error);
    }

    const refreshToken = await decryptSharepointSecret({
      purpose: "sharepoint_refresh_token",
      ciphertext: connection.refreshTokenEncrypted,
      iv: connection.refreshTokenIv,
      organizationId: connection.organizationId,
      userId: connection.userId,
    });

    const refreshed = await refreshAccessToken({
      clientId: config.value.clientId,
      clientSecret: config.value.clientSecret,
      refreshToken,
      tenantId: config.value.tenantId,
    });

    if (Result.isError(refreshed)) {
      yield* Result.await(markReconnectRequired({ connection, safeDb }));
      return Result.err(reconnectRequiredError());
    }

    const token = refreshed.value;
    const encryptedAccess = await encryptSharepointSecret({
      purpose: "sharepoint_access_token",
      secret: token.access_token,
      organizationId: connection.organizationId,
      userId: connection.userId,
    });
    const encryptedRefresh = token.refresh_token
      ? await encryptSharepointSecret({
          purpose: "sharepoint_refresh_token",
          secret: token.refresh_token,
          organizationId: connection.organizationId,
          userId: connection.userId,
        })
      : null;

    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — token-refresh bookkeeping: rotates the stored access /
        // refresh tokens after a silent Graph refresh. The user-facing
        // lifecycle events (connect / disconnect / org-disable purge) are the
        // audited surface.
        await tx
          .update(sharepointConnections)
          .set({
            accessTokenEncrypted: encryptedAccess.ciphertext,
            accessTokenIv: encryptedAccess.iv,
            ...(encryptedRefresh
              ? {
                  refreshTokenEncrypted: encryptedRefresh.ciphertext,
                  refreshTokenIv: encryptedRefresh.iv,
                }
              : {}),
            tokenType: token.token_type ?? "Bearer",
            scope: token.scope ?? null,
            expiresAt: tokenExpiresAt(token),
            status: "connected",
            lastUsedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(sharepointConnections.id, connection.id),
              eq(
                sharepointConnections.organizationId,
                connection.organizationId,
              ),
              eq(sharepointConnections.userId, connection.userId),
            ),
          );
      }),
    );

    // Re-decrypt what we just stored so the returned value is minted through
    // the single brand boundary, rather than casting the raw string here.
    const accessToken = await decryptSharepointSecret({
      purpose: "sharepoint_access_token",
      ciphertext: encryptedAccess.ciphertext,
      iv: encryptedAccess.iv,
      organizationId: connection.organizationId,
      userId: connection.userId,
    });
    return Result.ok({ accessToken, accessTokenIv: encryptedAccess.iv });
  });

const meResponseSchema = v.looseObject({
  userPrincipalName: v.optional(v.string()),
  displayName: v.optional(v.string()),
  mail: v.optional(v.string()),
});

/**
 * Best-effort display label for the connected Microsoft account, read once at
 * connect time. Boundary try/catch: a failure here must never block the
 * connection, so it degrades to `null`. `accessToken` is the raw token fresh
 * from the code exchange (not yet a stored `Secret`).
 */
export const fetchAccountLabel = async (
  accessToken: string,
): Promise<string | null> => {
  try {
    const url = new URL(`${GRAPH_API_BASE_URL}/me`);
    url.searchParams.set("$select", "userPrincipalName,displayName,mail");
    const response = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      timeoutMs: GRAPH_FETCH_TIMEOUT_MS,
    });
    if (!response.ok) {
      return null;
    }
    const parsed = v.parse(meResponseSchema, await response.json());
    return (
      parsed.userPrincipalName ?? parsed.mail ?? parsed.displayName ?? null
    );
  } catch {
    return null;
  }
};

// Browsing. Every read below is delegated: Microsoft evaluates the caller's
// own SharePoint and OneDrive permissions, so a listing never shows more than
// the person could open in Microsoft 365 themselves.

/** Largest JSON page body accepted from Graph (a 200-item page is ~200 KB). */
const GRAPH_JSON_MAX_BYTES = 4 * 1024 * 1024;
const RETRY_AFTER_DEFAULT_MS = 5000;
const RETRY_AFTER_MAX_MS = 120_000;

export type SharepointGraphError = HandlerError<
  400 | 403 | 404 | 409 | 413 | 429 | 502
>;

/**
 * Milliseconds a `Retry-After` header asks for. Graph sends delta-seconds; a
 * missing, zero or other value (an HTTP date included) yields the default, and
 * the result is clamped so a broken value cannot park a client for hours.
 */
export const parseRetryAfterMs = (header: string | null): number => {
  const seconds = parseIntegerToken(header?.trim(), {
    sign: "unsigned",
    min: 1,
  }).unwrapOr(null);
  return seconds === null
    ? RETRY_AFTER_DEFAULT_MS
    : Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
};

const upstreamError = (message: string, cause?: unknown): HandlerError<502> =>
  new HandlerError({ status: 502, code: "internal_error", message, cause });

/**
 * One Graph refusal mapped to the client outcome it stands for. A 401 means
 * the stored grant no longer works (revoked consent, disabled account), so it
 * asks for a reconnect rather than a retry.
 */
export const graphRefusal = ({
  status,
  retryAfter,
  cursorSent,
}: {
  status: number;
  retryAfter: string | null;
  cursorSent: boolean;
}): SharepointGraphError => {
  switch (status) {
    case 400:
      return cursorSent
        ? new HandlerError({
            status: 400,
            code: SHAREPOINT_REFUSAL_CODE.invalidCursor,
            message: "Microsoft Graph rejected the pagination cursor",
            hint: "Restart the listing without a cursor.",
          })
        : upstreamError("Microsoft Graph rejected the request (HTTP 400)");
    case 401:
      return reconnectRequiredError();
    case 403:
      return new HandlerError({
        status: 403,
        code: SHAREPOINT_REFUSAL_CODE.accessDenied,
        message: "Microsoft denied access to this SharePoint resource",
      });
    case 404:
    case 410:
      return new HandlerError({
        status: 404,
        code: SHAREPOINT_REFUSAL_CODE.notFound,
        message: "The SharePoint site, library or item was not found",
      });
    case 429:
    case 503:
      return new HandlerError({
        status: 429,
        code: SHAREPOINT_REFUSAL_CODE.throttled,
        message: "Microsoft Graph is throttling requests",
        retryable: true,
        retryAfterMs: parseRetryAfterMs(retryAfter),
      });
    default:
      return upstreamError(`Microsoft Graph returned HTTP ${status}`);
  }
};

/**
 * The cursor for the page after this one: the query string of Graph's
 * `@odata.nextLink`. Only the query string travels, never the URL, so a
 * client-supplied cursor is replayed against a path and host this API chose
 * and cannot steer the request elsewhere. A next link without a query string
 * would drop the remaining pages silently, so it is an upstream error.
 */
export const cursorFromNextLink = (
  nextLink: string | undefined,
): Result<string | null, HandlerError<502>> => {
  if (nextLink === undefined) {
    return Result.ok(null);
  }
  const url = URL.parse(nextLink);
  if (url === null || url.search.length <= 1) {
    return Result.err(
      upstreamError("Microsoft Graph returned an unusable next-page link"),
    );
  }
  return Result.ok(url.search.slice(1));
};

/**
 * The query for one page. A cursor carries Graph's continuation token, but
 * the parameters this API chose for the first page (`$top`, `$select`, the
 * search) are set again over it, so a client cursor cannot raise the page
 * size past the validated limit or change what is selected.
 */
export const replayQuery = (
  cursor: string | null,
  query: Record<string, string>,
): URLSearchParams => {
  const params = new URLSearchParams(cursor ?? "");
  for (const [key, value] of Object.entries(query)) {
    params.set(key, value);
  }
  return params;
};

type GraphJsonRequest = {
  accessToken: AccessToken;
  /** Path below the Graph base URL, segments already encoded. */
  path: string;
  query: URLSearchParams;
  /** Whether the query is a client cursor, so a 400 can name it. */
  cursorSent: boolean;
};

/** One delegated Graph GET whose JSON body the caller validates. */
const getGraphJson = async ({
  accessToken,
  path,
  query,
  cursorSent,
}: GraphJsonRequest): Promise<Result<unknown, SharepointGraphError>> => {
  const url = new URL(`${GRAPH_API_BASE_URL}${path}`);
  url.search = query.toString();
  const response = await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        redirect: "error",
        timeout: { type: "headers", ms: GRAPH_FETCH_TIMEOUT_MS },
      }),
    catch: (cause) => upstreamError("Failed to reach Microsoft Graph", cause),
  });
  if (Result.isError(response)) {
    return response;
  }
  if (!response.value.ok) {
    // Graph error bodies are not read: the status and Retry-After decide.
    await Promise.allSettled([response.value.body?.cancel()]);
    return Result.err(
      graphRefusal({
        status: response.value.status,
        retryAfter: response.value.headers.get("retry-after"),
        cursorSent,
      }),
    );
  }

  return await Result.tryPromise({
    try: async (): Promise<unknown> =>
      await readBodyJsonWithIdleDeadline(response.value, {
        idleMs: GRAPH_FETCH_TIMEOUT_MS,
        maxBytes: GRAPH_JSON_MAX_BYTES,
      }),
    catch: (cause) =>
      upstreamError("Microsoft Graph returned an unreadable body", cause),
  });
};

type GraphListRequest<TSchema extends v.GenericSchema> = {
  accessToken: AccessToken;
  /** Path below the Graph base URL, segments already encoded. */
  path: string;
  /** First-page query; a cursor replaces it whole. */
  query: Record<string, string>;
  cursor: string | null;
  itemSchema: TSchema;
};

type GraphListPage<TItem> = { items: TItem[]; nextCursor: string | null };

const listGraphPage = async <TSchema extends v.GenericSchema>({
  accessToken,
  path,
  query,
  cursor,
  itemSchema,
}: GraphListRequest<TSchema>): Promise<
  Result<GraphListPage<v.InferOutput<TSchema>>, SharepointGraphError>
> => {
  const body = await getGraphJson({
    accessToken,
    path,
    query: replayQuery(cursor, query),
    cursorSent: cursor !== null,
  });
  if (Result.isError(body)) {
    return body;
  }

  const parsed = v.safeParse(
    v.looseObject({
      value: v.array(itemSchema),
      "@odata.nextLink": v.optional(v.string()),
    }),
    body.value,
  );
  if (!parsed.success) {
    return Result.err(
      upstreamError("Microsoft Graph returned an unexpected response"),
    );
  }

  const nextCursor = cursorFromNextLink(parsed.output["@odata.nextLink"]);
  if (Result.isError(nextCursor)) {
    return nextCursor;
  }
  return Result.ok({
    items: parsed.output.value,
    nextCursor: nextCursor.value,
  });
};

const graphSiteSchema = v.looseObject({
  id: v.string(),
  name: v.optional(v.string()),
  displayName: v.optional(v.string()),
  webUrl: v.optional(v.string()),
});

type SharepointSite = {
  id: string;
  name: string;
  webUrl: string | null;
};

const toSharepointSite = (
  site: v.InferOutput<typeof graphSiteSchema>,
): SharepointSite => ({
  id: site.id,
  name: site.displayName ?? site.name ?? site.id,
  webUrl: site.webUrl ?? null,
});

type SitesRequest = {
  accessToken: AccessToken;
  /** Free-text site search; `null` lists the sites the caller follows. */
  search: string | null;
  cursor: string | null;
};

/**
 * Sites the caller follows, or the sites a search finds. Neither Graph
 * endpoint documents a page-size parameter, so Graph picks the page size.
 */
export const listSharepointSites = async ({
  accessToken,
  search,
  cursor,
}: SitesRequest): Promise<
  Result<GraphListPage<SharepointSite>, SharepointGraphError>
> => {
  const page = await listGraphPage({
    accessToken,
    path: search === null ? "/me/followedSites" : "/sites",
    query: search === null ? {} : { search },
    cursor,
    itemSchema: graphSiteSchema,
  });
  return page.map(({ items, nextCursor }) => ({
    items: items.map(toSharepointSite),
    nextCursor,
  }));
};

const graphDriveSchema = v.looseObject({
  id: v.string(),
  name: v.optional(v.string()),
  driveType: v.optional(v.string()),
  webUrl: v.optional(v.string()),
});

type SharepointDrive = {
  id: string;
  name: string;
  /** Graph's `driveType`: `personal`, `business` or `documentLibrary`. */
  driveType: string | null;
  webUrl: string | null;
};

const toSharepointDrive = (
  drive: v.InferOutput<typeof graphDriveSchema>,
): SharepointDrive => ({
  id: drive.id,
  name: drive.name ?? drive.id,
  driveType: drive.driveType ?? null,
  webUrl: drive.webUrl ?? null,
});

type DrivesRequest = {
  accessToken: AccessToken;
  /** A site's document libraries; `null` lists the caller's own drives. */
  siteId: string | null;
  cursor: string | null;
  limit: number;
};

export const listSharepointDrives = async ({
  accessToken,
  siteId,
  cursor,
  limit,
}: DrivesRequest): Promise<
  Result<Page<SharepointDrive>, SharepointGraphError>
> => {
  const page = await listGraphPage({
    accessToken,
    path:
      siteId === null
        ? "/me/drives"
        : `/sites/${encodeURIComponent(siteId)}/drives`,
    query: { $top: String(limit), $select: "id,name,driveType,webUrl" },
    cursor,
    itemSchema: graphDriveSchema,
  });
  return page.map(({ items, nextCursor }) => ({
    items: items.map(toSharepointDrive),
    nextCursor,
    limit,
  }));
};

const graphDriveItemSchema = v.looseObject({
  id: v.string(),
  name: v.optional(v.string()),
  webUrl: v.optional(v.string()),
  eTag: v.optional(v.string()),
  size: v.optional(v.number()),
  lastModifiedDateTime: v.optional(v.string()),
  folder: v.optional(v.looseObject({})),
  file: v.optional(v.looseObject({ mimeType: v.optional(v.string()) })),
  parentReference: v.optional(
    v.looseObject({ driveId: v.optional(v.string()) }),
  ),
});

export type GraphDriveItem = v.InferOutput<typeof graphDriveItemSchema>;

/**
 * What a drive item is to a picker. `other` covers items that are neither a
 * plain file nor a folder (OneNote notebooks and other packages); they are
 * listed so a folder reads as Microsoft shows it, but cannot be imported.
 */
export const SHAREPOINT_ITEM_KIND = {
  file: "file",
  folder: "folder",
  other: "other",
} as const;

type SharepointItemKind =
  (typeof SHAREPOINT_ITEM_KIND)[keyof typeof SHAREPOINT_ITEM_KIND];

export type SharepointDriveItem = {
  id: string;
  driveId: string;
  name: string;
  kind: SharepointItemKind;
  size: number | null;
  mimeType: string | null;
  lastModifiedAt: string | null;
  webUrl: string | null;
  eTag: string | null;
};

const itemKind = (item: GraphDriveItem): SharepointItemKind => {
  if (item.folder !== undefined) {
    return SHAREPOINT_ITEM_KIND.folder;
  }
  return item.file === undefined
    ? SHAREPOINT_ITEM_KIND.other
    : SHAREPOINT_ITEM_KIND.file;
};

/** `driveId` is the drive that was listed when Graph omits the parent. */
export const toSharepointDriveItem = (
  item: GraphDriveItem,
  driveId: string,
): SharepointDriveItem => ({
  id: item.id,
  driveId: item.parentReference?.driveId ?? driveId,
  name: item.name ?? item.id,
  kind: itemKind(item),
  size: item.size ?? null,
  mimeType: item.file?.mimeType ?? null,
  lastModifiedAt: item.lastModifiedDateTime ?? null,
  webUrl: item.webUrl ?? null,
  eTag: item.eTag ?? null,
});

/** The folder id that names a drive's top level. */
export const SHAREPOINT_ROOT_ITEM_ID = "root";

const drivePathOf = (driveId: string): string =>
  `/drives/${encodeURIComponent(driveId)}`;

const DRIVE_ITEM_SELECT =
  "id,name,size,webUrl,eTag,lastModifiedDateTime,file,folder,package,parentReference";

type ChildrenRequest = {
  accessToken: AccessToken;
  driveId: string;
  /** A folder's item id, or {@link SHAREPOINT_ROOT_ITEM_ID}. */
  itemId: string;
  cursor: string | null;
  limit: number;
};

export const listSharepointChildren = async ({
  accessToken,
  driveId,
  itemId,
  cursor,
  limit,
}: ChildrenRequest): Promise<
  Result<Page<SharepointDriveItem>, SharepointGraphError>
> => {
  const drivePath = drivePathOf(driveId);
  const page = await listGraphPage({
    accessToken,
    path:
      itemId === SHAREPOINT_ROOT_ITEM_ID
        ? `${drivePath}/root/children`
        : `${drivePath}/items/${encodeURIComponent(itemId)}/children`,
    query: { $top: String(limit), $select: DRIVE_ITEM_SELECT },
    cursor,
    itemSchema: graphDriveItemSchema,
  });
  return page.map(({ items, nextCursor }) => ({
    items: items.map((item) => toSharepointDriveItem(item, driveId)),
    nextCursor,
    limit,
  }));
};

type DriveItemRequest = {
  accessToken: AccessToken;
  driveId: string;
  itemId: string;
};

/** One drive item's current metadata, as the caller may see it. */
export const getSharepointDriveItem = async ({
  accessToken,
  driveId,
  itemId,
}: DriveItemRequest): Promise<
  Result<SharepointDriveItem, SharepointGraphError>
> => {
  const body = await getGraphJson({
    accessToken,
    path: `${drivePathOf(driveId)}/items/${encodeURIComponent(itemId)}`,
    query: new URLSearchParams({ $select: DRIVE_ITEM_SELECT }),
    cursorSent: false,
  });
  if (Result.isError(body)) {
    return body;
  }
  const parsed = v.safeParse(graphDriveItemSchema, body.value);
  if (!parsed.success) {
    return Result.err(
      upstreamError("Microsoft Graph returned an unexpected drive item"),
    );
  }
  return Result.ok(toSharepointDriveItem(parsed.output, driveId));
};

const GRAPH_DOWNLOAD_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Hosts Microsoft serves pre-authenticated drive downloads from: SharePoint
 * and OneDrive for work or school, and personal OneDrive.
 */
const DOWNLOAD_HOST_SUFFIXES = [".sharepoint.com", ".1drv.com"] as const;

/** A Graph download link this client follows: HTTPS on a Microsoft file host. */
const isSharepointDownloadUrl = (url: URL): boolean =>
  url.protocol === "https:" &&
  url.port === "" &&
  DOWNLOAD_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));

type DownloadRequest = DriveItemRequest & {
  /** The largest file accepted; a longer body fails rather than truncates. */
  maxBytes: number;
};

/**
 * A drive item's bytes. Graph answers `/content` with a redirect to a
 * short-lived pre-authenticated URL on a Microsoft file host; it is followed
 * by hand, only to such a host and without the bearer token, so the token
 * never leaves Graph's own host.
 */
export const downloadSharepointFile = async ({
  accessToken,
  driveId,
  itemId,
  maxBytes,
}: DownloadRequest): Promise<Result<Uint8Array, SharepointGraphError>> => {
  const contentUrl = new URL(
    `${GRAPH_API_BASE_URL}${drivePathOf(driveId)}/items/${encodeURIComponent(itemId)}/content`,
  );
  const first = await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(contentUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: "manual",
        timeout: { type: "headers", ms: GRAPH_DOWNLOAD_TIMEOUT_MS },
      }),
    catch: (cause) => upstreamError("Failed to reach Microsoft Graph", cause),
  });
  if (Result.isError(first)) {
    return first;
  }

  let response = first.value;
  let redirected = false;
  if (REDIRECT_STATUSES.has(response.status)) {
    await Promise.allSettled([response.body?.cancel()]);
    const location = URL.parse(response.headers.get("location") ?? "");
    if (location === null || !isSharepointDownloadUrl(location)) {
      return Result.err(
        upstreamError("Microsoft Graph returned an unusable download link"),
      );
    }
    const downloaded = await Result.tryPromise({
      try: async () =>
        // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- Microsoft Graph's own /content redirect, checked above to be HTTPS on a Microsoft file host; sent without credentials, redirects refused
        await fetchWithTimeout(location, {
          redirect: "error",
          timeout: { type: "headers", ms: GRAPH_DOWNLOAD_TIMEOUT_MS },
        }),
      catch: (cause) =>
        upstreamError("Failed to download the SharePoint file", cause),
    });
    if (Result.isError(downloaded)) {
      return downloaded;
    }
    response = downloaded.value;
    redirected = true;
  }

  if (!response.ok) {
    await Promise.allSettled([response.body?.cancel()]);
    // The file host answers for a short-lived pre-authenticated link, not
    // for the stored grant: its refusal fails this file, never the grant.
    if (redirected && (response.status === 401 || response.status === 403)) {
      return Result.err(
        upstreamError(
          `The SharePoint download link was refused (HTTP ${response.status})`,
        ),
      );
    }
    return Result.err(
      graphRefusal({
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        cursorSent: false,
      }),
    );
  }
  return await Result.tryPromise({
    try: async () =>
      await readBodyWithIdleDeadline(response, {
        idleMs: GRAPH_DOWNLOAD_TIMEOUT_MS,
        maxBytes,
      }),
    catch: (cause) =>
      BodyByteLimitError.is(cause)
        ? new HandlerError({
            status: 413,
            code: SHAREPOINT_REFUSAL_CODE.fileTooLarge,
            message: "The file exceeds the document size limit",
          })
        : upstreamError("Failed to read the SharePoint file", cause),
  });
};
