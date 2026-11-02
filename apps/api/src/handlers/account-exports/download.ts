import { Result } from "better-result";

import { accountExportParams } from "@/api/handlers/account-exports/params";
import { CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL } from "@/api/http/cache";
import { status } from "@/api/http/status";
import { recordAccountExportDownload } from "@/api/lib/account-export/store";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import {
  AUTH_REJECTION_BODY,
  authenticateSession,
  resolveCredentialMemberAuthorization,
} from "@/api/lib/auth";
import type { CallerOutcome, SessionCaller } from "@/api/lib/auth";
import { hasAccountExportAuthority } from "@/api/lib/auth/account-export-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { openS3ObjectStreamWithSignal } from "@/api/lib/s3";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { authenticateAccountExportRequest } from "@/api/mcp/auth";
import { McpTokenVerificationError } from "@/api/mcp/errors";

const ACCOUNT_EXPORT_DOWNLOAD_VERIFICATION_UNAVAILABLE = failureSink({
  event: "account_export.download_verification_unavailable",
  expected: [],
});

const ACCOUNT_EXPORT_DOWNLOAD_MEMBERSHIP_UNAVAILABLE = failureSink({
  event: "account_export.download_membership_unavailable",
  expected: [],
});

// Authentication answers before the route handler binds its request scope.
const DOWNLOAD_AUTHENTICATION_SCOPE = {
  type: "handler",
  handlerId: "account_export.download_authentication",
} as const;

type DownloadAuthenticationDependencies = {
  authenticateOAuth?: typeof authenticateAccountExportRequest;
  authenticateBrowserSession?: typeof authenticateSession;
  resolveOAuthMembership?: typeof resolveCredentialMemberAuthorization;
};

const authenticateAccountExportDownload = async (
  ctx: Parameters<typeof authenticateSession>[0],
  access: Parameters<typeof authenticateSession>[1],
  {
    authenticateOAuth = authenticateAccountExportRequest,
    authenticateBrowserSession = authenticateSession,
    resolveOAuthMembership = resolveCredentialMemberAuthorization,
  }: DownloadAuthenticationDependencies = {},
): Promise<CallerOutcome<SessionCaller>> => {
  const authorization = ctx.request.headers.get("authorization");
  if (authorization === null) {
    return await authenticateBrowserSession(ctx, access);
  }
  if (!authorization.startsWith("Bearer ")) {
    return { ok: false, answer: status(401, AUTH_REJECTION_BODY[401]) };
  }
  const authenticated = await authenticateOAuth(authorization.slice(7));
  if (Result.isError(authenticated)) {
    if (authenticated.error instanceof McpTokenVerificationError) {
      observeFailure(authenticated.error, {
        sink: ACCOUNT_EXPORT_DOWNLOAD_VERIFICATION_UNAVAILABLE,
        scope: DOWNLOAD_AUTHENTICATION_SCOPE,
        request: ctx.request,
      });
      return { ok: false, answer: status(500, AUTH_REJECTION_BODY[500]) };
    }
    return { ok: false, answer: status(403, AUTH_REJECTION_BODY[403]) };
  }
  if (
    !hasAccountExportAuthority(
      {
        credential: authenticated.value.credential,
        grantedScopes: authenticated.value.scopes,
      },
      "read",
    )
  ) {
    return { ok: false, answer: status(403, AUTH_REJECTION_BODY[403]) };
  }
  const userId = parseAuthProviderId<"user">(authenticated.value.userId);
  if (userId === null) {
    return { ok: false, answer: status(401, AUTH_REJECTION_BODY[401]) };
  }
  const organizationId = parseAuthProviderId<"organization">(
    authenticated.value.organizationId,
  );
  if (organizationId === null) {
    return { ok: false, answer: status(403, AUTH_REJECTION_BODY[403]) };
  }
  const membership = await Result.tryPromise(
    async () => await resolveOAuthMembership({ userId, organizationId }),
  );
  if (Result.isError(membership)) {
    observeFailure(membership.error, {
      sink: ACCOUNT_EXPORT_DOWNLOAD_MEMBERSHIP_UNAVAILABLE,
      scope: DOWNLOAD_AUTHENTICATION_SCOPE,
      request: ctx.request,
    });
    return { ok: false, answer: status(500, AUTH_REJECTION_BODY[500]) };
  }
  if (
    membership.value === null ||
    membership.value.userDeleted ||
    membership.value.memberId !== authenticated.value.memberId
  ) {
    return { ok: false, answer: status(403, AUTH_REJECTION_BODY[403]) };
  }
  return {
    ok: true,
    caller: { user: { id: userId, email: membership.value.email } },
  };
};

type DownloadPersonalDataExportDependencies =
  DownloadAuthenticationDependencies & {
    recordDownload?: typeof recordAccountExportDownload;
    openObjectStream?: typeof openS3ObjectStreamWithSignal;
  };

export const createDownloadPersonalDataExport = ({
  recordDownload = recordAccountExportDownload,
  openObjectStream = openS3ObjectStreamWithSignal,
  ...authenticationDependencies
}: DownloadPersonalDataExportDependencies = {}) =>
  createSafeSessionHandler(
    {
      accountAccess: ACCOUNT_ACCESS.accountControl,
      contract: "patch",
      mcp: { type: "internal", reason: "auth_plumbing" },
      params: accountExportParams,
      contentDelivery: { type: "audited" },
      transport: {
        type: "file-response",
        response: { mediaTypes: ["application/zip"] },
        alternative: {
          type: "partial",
          via: ["account-exports.download.get"],
          limitation:
            "Returns an authenticated download URL; ZIP bytes require HTTP.",
        },
      },
    },
    async function* ({ user, params: { exportId }, request }) {
      const row = yield* Result.await(
        Result.tryPromise(
          async () => await recordDownload({ id: exportId, userId: user.id }),
        ),
      );
      const objectKey = row?.objectKey ?? null;
      if (row === null || objectKey === null) {
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Export is unavailable or expired.",
          }),
        );
      }
      const source = yield* Result.await(
        Result.tryPromise(
          async () => await openObjectStream(objectKey, request.signal),
        ),
      );
      return Result.ok(
        secureDocumentResponse({
          body: source.body,
          contentType: "application/zip",
          disposition: "attachment",
          fileName: sanitizeFilename(`personal-data-${row.id}.zip`),
          ...(source.contentLength === undefined
            ? {}
            : { contentLength: source.contentLength }),
          additionalHeaders: { [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL },
        }),
      );
    },
    {
      authenticate: async (ctx, access) =>
        await authenticateAccountExportDownload(
          ctx,
          access,
          authenticationDependencies,
        ),
    },
  );

const downloadPersonalDataExport = createDownloadPersonalDataExport();

export default downloadPersonalDataExport;
