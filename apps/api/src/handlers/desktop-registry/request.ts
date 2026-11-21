import { panic, Result } from "better-result";
import type * as v from "valibot";

import type {
  DesktopRegistryConfig,
  DesktopRegistryDefaultFormat,
  DesktopRegistrySearchResponse,
} from "@stll/api-contract/desktop-registry";
import type {
  DesktopAccountIdentity,
  LinkedAccountSnapshot,
} from "@stll/api-contract/desktop-rpc";
import { Temporal } from "@stll/time";

import {
  formatDesktopRegistry,
  getDesktopRegistryConfig,
  searchDesktopRegistry,
  setDesktopRegistryDefaultFormat,
} from "@/api/handlers/desktop-registry/service";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import {
  authorizeDesktopAccount,
  authorizeDesktopRegistry,
} from "@/api/lib/business-registries/desktop/auth";
import {
  desktopRegistryRequestBody,
  desktopRegistryRequestHeaders,
} from "@/api/lib/business-registries/desktop/request-contract";
import { revokeDesktopRegistryCredential } from "@/api/lib/business-registries/desktop/revocation";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  cache: { kind: "none" },
  body: desktopRegistryRequestBody,
  headers: desktopRegistryRequestHeaders,
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
      identity: DesktopAccountIdentity;
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
          const account = yield* Result.await(
            Result.tryPromise({
              try: async () =>
                await context.scopedDb((tx) =>
                  tx.query.user.findFirst({
                    where: { id: { eq: context.userId } },
                    columns: { email: true, name: true },
                  }),
                ),
              catch: (cause) =>
                new HandlerError({
                  status: 503,
                  code: "internal_error",
                  message: "Could not verify desktop account",
                  cause,
                }),
            }),
          );
          if (!account) {
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
            account: {
              ...account,
              verifiedAt: Temporal.Now.instant().toString(),
            },
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
