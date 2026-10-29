/** Bounded Microsoft Graph reads for the delegated SharePoint connection. */
import { Result } from "better-result";
import * as v from "valibot";

import { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { Page } from "@/api/lib/pagination";
import type { AccessToken } from "@/api/lib/secret-brands";

const GRAPH_FETCH_TIMEOUT_MS = 10_000;
const GRAPH_ACCOUNT_RESPONSE_MAX_BYTES = 64 * 1024;
const GRAPH_DRIVE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const GRAPH_API_BASE_URL = "https://graph.microsoft.com/v1.0";
const ACCOUNT_LABEL_FAILED_SINK = failureSink({
  event: "sharepoint.account_label_lookup_failed",
  expected: [],
});
const driveItemSchema = v.looseObject({
  id: v.string(),
  name: v.optional(v.string()),
  webUrl: v.optional(v.string()),
  eTag: v.optional(v.string()),
  size: v.optional(v.number()),
  lastModifiedDateTime: v.optional(v.string()),
  folder: v.optional(v.looseObject({ childCount: v.optional(v.number()) })),
  file: v.optional(v.looseObject({ mimeType: v.optional(v.string()) })),
});

const driveChildrenResponseSchema = v.looseObject({
  value: v.array(driveItemSchema),
  "@odata.nextLink": v.optional(v.string()),
});

export type DriveChildrenResponse = v.InferOutput<
  typeof driveChildrenResponseSchema
>;

export type SharepointDriveItem = {
  id: string;
  name: string;
  kind: "file" | "folder";
  mimeType: string | null;
  webUrl: string | null;
  eTag: string | null;
  size: number | null;
  lastModifiedDateTime: string | null;
};

const toDriveItem = (
  item: v.InferOutput<typeof driveItemSchema>,
): SharepointDriveItem => ({
  id: item.id,
  name: item.name ?? "Untitled",
  kind: item.folder ? "folder" : "file",
  mimeType: item.file?.mimeType ?? null,
  webUrl: item.webUrl ?? null,
  eTag: item.eTag ?? null,
  size: item.size ?? null,
  lastModifiedDateTime: item.lastModifiedDateTime ?? null,
});

// Graph returns an opaque `$skiptoken` inside `@odata.nextLink`. Extract just
// the token and re-issue the request ourselves; we never fetch a
// client-supplied URL (that would be an SSRF vector).
const parseSkipToken = (nextLink: string | undefined): string | null => {
  if (!nextLink) {
    return null;
  }
  try {
    return new URL(nextLink).searchParams.get("$skiptoken");
  } catch {
    return null;
  }
};

/** Pure mapping from a Graph children response to our `Page<T>` envelope. */
export const mapDriveChildrenToPage = (
  response: DriveChildrenResponse,
  limit: number,
): Page<SharepointDriveItem> => ({
  items: response.value.map(toDriveItem),
  nextCursor: parseSkipToken(response["@odata.nextLink"]),
  limit,
});

const meResponseSchema = v.looseObject({
  userPrincipalName: v.optional(v.string()),
  displayName: v.optional(v.string()),
  mail: v.optional(v.string()),
});

/**
 * Best-effort display label for the connected Microsoft account, read once at
 * connect time. The callback decides whether a failed optional lookup blocks
 * its authorized token connection.
 */
export const fetchAccountLabel = async ({
  accessToken,
  fetchBytes = safeOutboundFetchBytes,
  permit,
  signal,
}: {
  accessToken: string;
  fetchBytes?: typeof safeOutboundFetchBytes;
  permit: ThirdPartyOutboundPermit;
  signal?: AbortSignal | undefined;
}) => {
  const result = await Result.tryPromise({
    try: async () => {
      const url = new URL(`${GRAPH_API_BASE_URL}/me`);
      url.searchParams.set("$select", "userPrincipalName,displayName,mail");
      const response = await fetchBytes({
        url,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        maxBytes: GRAPH_ACCOUNT_RESPONSE_MAX_BYTES,
        permit,
        signal,
        timeoutMs: GRAPH_FETCH_TIMEOUT_MS,
        redirect: "error",
      });
      if (Result.isError(response)) {
        throw response.error;
      }
      if (!response.value.ok) {
        throw new HandlerError({
          status: 502,
          code: "internal_error",
          message: `Microsoft account lookup returned HTTP ${response.value.status}`,
        });
      }
      const json = Result.try((): unknown =>
        JSON.parse(new TextDecoder().decode(response.value.body)),
      );
      const parsed = Result.isError(json)
        ? null
        : v.safeParse(meResponseSchema, json.value);
      if (!parsed?.success) {
        throw new HandlerError({
          status: 502,
          code: "internal_error",
          message: "Invalid Microsoft account response",
        });
      }
      return (
        parsed.output.userPrincipalName ??
        parsed.output.mail ??
        parsed.output.displayName ??
        null
      );
    },
    catch: (cause) =>
      new HandlerError({
        status: 502,
        code: "internal_error",
        message: HandlerError.is(cause)
          ? cause.message
          : "Microsoft account lookup failed",
        cause,
      }),
  });
  if (Result.isError(result)) {
    observeFailure(result.error, { sink: ACCOUNT_LABEL_FAILED_SINK });
  }
  return result;
};

export const listDriveRootChildren = async ({
  accessToken,
  cursor,
  fetchBytes = safeOutboundFetchBytes,
  limit,
  permit,
  signal,
}: {
  accessToken: AccessToken;
  cursor: string | null;
  fetchBytes?: typeof safeOutboundFetchBytes;
  limit: number;
  permit: ThirdPartyOutboundPermit;
  signal?: AbortSignal | undefined;
}): Promise<Result<Page<SharepointDriveItem>, HandlerError<502>>> =>
  await Result.tryPromise({
    try: async () => {
      const url = new URL(`${GRAPH_API_BASE_URL}/me/drive/root/children`);
      url.searchParams.set("$top", String(limit));
      if (cursor) {
        url.searchParams.set("$skiptoken", cursor);
      }

      const response = await fetchBytes({
        url,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        maxBytes: GRAPH_DRIVE_RESPONSE_MAX_BYTES,
        permit,
        signal,
        timeoutMs: GRAPH_FETCH_TIMEOUT_MS,
        redirect: "error",
      });
      if (Result.isError(response)) {
        throw response.error;
      }
      if (!response.value.ok) {
        throw new HandlerError({
          status: 502,
          code: "internal_error",
          message: `Microsoft Graph returned HTTP ${response.value.status}`,
        });
      }

      const json = Result.try((): unknown =>
        JSON.parse(new TextDecoder().decode(response.value.body)),
      );
      const parsed = Result.isError(json)
        ? null
        : v.safeParse(driveChildrenResponseSchema, json.value);
      if (!parsed?.success) {
        throw new HandlerError({
          status: 502,
          code: "internal_error",
          message: "Invalid Microsoft Graph drive response",
        });
      }
      return mapDriveChildrenToPage(parsed.output, limit);
    },
    // Always surface a 502 so the Result error channel unifies to
    // HandlerError<502>; preserve the message from our own thrown 502.
    catch: (cause): HandlerError<502> =>
      new HandlerError({
        status: 502,
        code: "internal_error",
        message: HandlerError.is(cause)
          ? cause.message
          : "Failed to reach Microsoft Graph",
        cause,
      }),
  });
