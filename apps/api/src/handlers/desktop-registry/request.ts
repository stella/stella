import { panic, Result } from "better-result";
import * as v from "valibot";

import { BUSINESS_REGISTRY_SLUGS } from "@stll/api-contract";
import {
  DESKTOP_REGISTRY_DEFAULT_FORMAT_SOURCE,
  type DesktopRegistryConfig,
  type DesktopRegistryDefaultFormat,
  type DesktopRegistrySearchResponse,
} from "@stll/api-contract/desktop-registry";
import type {
  DesktopAccountIdentity,
  LinkedAccountSnapshot,
} from "@stll/api-contract/desktop-rpc";
import { Temporal } from "@stll/time";

import {
  DESKTOP_REGISTRY_RENDERED_TEXT_MAX_LENGTH,
  formatDesktopRegistry,
  getDesktopRegistryConfig,
  searchDesktopRegistry,
  setDesktopRegistryDefaultFormat,
} from "@/api/handlers/desktop-registry/service";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import {
  DESKTOP_ACCOUNT_IMAGE_MAX_LENGTH,
  desktopVerifiedAccount,
} from "@/api/lib/business-registries/desktop/account-image";
import {
  authorizeDesktopAccount,
  authorizeDesktopRegistry,
} from "@/api/lib/business-registries/desktop/auth";
import {
  desktopRegistryRequestBody,
  desktopRegistryRequestHeaders,
} from "@/api/lib/business-registries/desktop/request-contract";
import { revokeDesktopRegistryCredential } from "@/api/lib/business-registries/desktop/revocation";
import { userIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const defaultFormatSourceSchema = v.picklist([
  DESKTOP_REGISTRY_DEFAULT_FORMAT_SOURCE.user,
  DESKTOP_REGISTRY_DEFAULT_FORMAT_SOURCE.organization,
]);

const desktopRegistryDefaultFormatResponseSchema = v.strictObject({
  defaultFormatId: v.nullable(v.pipe(v.string(), v.maxLength(128))),
  defaultFormatSource: v.nullable(defaultFormatSourceSchema),
});

const desktopRegistryConfigResponseSchema = v.object({
  registries: v.pipe(
    v.array(
      v.object({
        id: v.picklist(BUSINESS_REGISTRY_SLUGS),
        name: v.pipe(v.string(), v.maxLength(256)),
        formatType: v.optional(
          v.picklist(["company-specification", "registry-reference"]),
        ),
        searchCapabilities: v.optional(
          v.object({
            nameSearch: v.picklist(["native", "verified-web", "unsupported"]),
            identifierKinds: v.pipe(
              v.array(v.pipe(v.string(), v.maxLength(128))),
              v.maxLength(16),
            ),
          }),
        ),
      }),
    ),
    v.maxLength(32),
  ),
  defaultRegistryId: v.nullable(v.picklist(BUSINESS_REGISTRY_SLUGS)),
  account: v.object({
    email: v.pipe(v.string(), v.maxLength(320)),
    name: v.nullable(v.pipe(v.string(), v.maxLength(256))),
    verifiedAt: v.pipe(v.string(), v.maxLength(64)),
  }),
  accountImage: v.nullable(
    v.pipe(v.string(), v.maxLength(DESKTOP_ACCOUNT_IMAGE_MAX_LENGTH)),
  ),
  identity: v.object({
    userId: userIdSchema,
    organizationId: v.pipe(v.string(), v.maxLength(128)),
  }),
  organizationName: v.pipe(v.string(), v.maxLength(256)),
});

const desktopRegistrySearchResponseSchema = v.object({
  ...desktopRegistryDefaultFormatResponseSchema.entries,
  formats: v.pipe(
    v.array(
      v.object({
        id: v.pipe(v.string(), v.maxLength(128)),
        name: v.pipe(v.string(), v.maxLength(256)),
      }),
    ),
    v.maxLength(256),
  ),
  results: v.pipe(
    v.array(
      v.object({
        id: v.pipe(v.string(), v.maxLength(128)),
        name: v.pipe(v.string(), v.maxLength(512)),
        text: v.pipe(
          v.string(),
          v.maxLength(DESKTOP_REGISTRY_RENDERED_TEXT_MAX_LENGTH),
        ),
        rendered: v.optional(
          v.pipe(
            v.string(),
            v.maxLength(DESKTOP_REGISTRY_RENDERED_TEXT_MAX_LENGTH),
          ),
        ),
      }),
    ),
    v.maxLength(100),
  ),
});

const desktopRegistryFormatResponseSchema = v.object({
  text: v.pipe(
    v.string(),
    v.maxLength(DESKTOP_REGISTRY_RENDERED_TEXT_MAX_LENGTH),
  ),
  rendered: v.pipe(
    v.string(),
    v.maxLength(DESKTOP_REGISTRY_RENDERED_TEXT_MAX_LENGTH),
  ),
});

// Keep `search` before `setDefaultFormat`: both carry `defaultFormatId` and
// `defaultFormatSource`, so matching the narrower shape first would strip
// `formats` and `results`.
const desktopRegistryReplyResponseSchema = v.union([
  desktopRegistryConfigResponseSchema,
  desktopRegistrySearchResponseSchema,
  desktopRegistryFormatResponseSchema,
  desktopRegistryDefaultFormatResponseSchema,
  v.object({ revoked: v.boolean() }),
]);

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  cache: { kind: "none" },
  body: desktopRegistryRequestBody,
  headers: desktopRegistryRequestHeaders,
  response: safePublicHandlerResponseSchemasWithStatusText(
    desktopRegistryReplyResponseSchema,
  ),
} as const;

export const desktopRequestAuthorization = {
  config: authorizeDesktopAccount,
  revoke: authorizeDesktopAccount,
  search: authorizeDesktopRegistry,
  format: authorizeDesktopRegistry,
  setDefaultFormat: authorizeDesktopRegistry,
} as const satisfies Record<
  v.InferOutput<typeof config.body>["type"],
  typeof authorizeDesktopAccount
>;

// A dedicated bearer boundary, not an unauthenticated registry proxy. The
// ordinary session middleware intentionally does not recognize these keys.
type RegistryReply =
  | (DesktopRegistryConfig & {
      account: LinkedAccountSnapshot;
      /** The member's picture for the desktop to show, or null. */
      accountImage: string | null;
      identity: DesktopAccountIdentity;
      organizationName: string;
    })
  | DesktopRegistrySearchResponse
  | { text: string; rendered: string }
  | DesktopRegistryDefaultFormat
  | { revoked: boolean };

export const createDesktopRegistryRequestEndpoint = (
  authorization = desktopRequestAuthorization,
) =>
  createSafePublicHandler(
    config,
    async function* ({ request, body }): SafeHandlerGenerator<RegistryReply> {
      const context = yield* Result.await(authorization[body.type](request));
      switch (body.type) {
        case "revoke": {
          const record = createAuditRecorder({
            organizationId: context.organizationId,
            userId: context.userId,
            request,
            server: null,
            workspaceId: null,
          });
          yield* Result.await(
            Result.tryPromise({
              try: async () =>
                await revokeDesktopRegistryCredential({
                  keyId: context.keyId,
                  organizationId: context.organizationId,
                  userId: context.userId,
                  recordAuditEvent: record,
                }),
              catch: () =>
                new HandlerError({
                  status: 503,
                  code: "internal_error",
                  message: "Could not disconnect registry search",
                }),
            }),
          );
          return Result.ok({ revoked: true });
        }
        case "config": {
          const linked = yield* Result.await(
            Result.tryPromise({
              try: async () =>
                await context.scopedDb(async (tx) => ({
                  account: await tx.query.user.findFirst({
                    where: { id: { eq: context.userId } },
                    columns: { email: true, image: true, name: true },
                  }),
                  organization: await tx.query.organization.findFirst({
                    where: { id: { eq: context.organizationId } },
                    columns: { name: true },
                  }),
                })),
              catch: (cause) =>
                new HandlerError({
                  status: 503,
                  code: "internal_error",
                  message: "Could not verify desktop account",
                  cause,
                }),
            }),
          );
          const { account, organization } = linked;
          if (!account || !organization) {
            return Result.err(
              new HandlerError({
                status: 401,
                message: "Desktop account is unavailable",
              }),
            );
          }
          const registryConfig = yield* Result.await(
            getDesktopRegistryConfig(context),
          );
          return Result.ok({
            ...registryConfig,
            identity: {
              userId: context.userId,
              organizationId: context.organizationId,
            },
            ...desktopVerifiedAccount(
              account,
              Temporal.Now.instant().toString(),
            ),
            // The desktop seeds the member's dictation words with it.
            organizationName: organization.name,
          });
        }
        case "search":
          return Result.ok(
            yield* Result.await(searchDesktopRegistry(context, body)),
          );
        case "format":
          return Result.ok(
            yield* Result.await(formatDesktopRegistry(context, body)),
          );
        case "setDefaultFormat":
          return Result.ok(
            yield* Result.await(setDesktopRegistryDefaultFormat(context, body)),
          );
        default:
          body satisfies never;
          return panic("Unknown desktop registry request");
      }
    },
  );

export default createDesktopRegistryRequestEndpoint();
