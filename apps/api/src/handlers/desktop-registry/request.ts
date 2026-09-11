import { panic, Result } from "better-result";
import { t } from "elysia";

import { BUSINESS_REGISTRY_SLUGS } from "@stll/api-contract";
import type {
  DesktopRegistryConfig,
  DesktopRegistrySearchResponse,
} from "@stll/api-contract/desktop-registry";

import {
  formatDesktopRegistry,
  getDesktopRegistryConfig,
  searchDesktopRegistry,
} from "@/api/handlers/desktop-registry/service";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { authorizeDesktopRegistry } from "@/api/lib/desktop-registry-auth";
import { revokeDesktopRegistryCredential } from "@/api/lib/desktop-registry-revocation";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const registry = t.UnionEnum(BUSINESS_REGISTRY_SLUGS);
const config = {
  mcp: { type: "internal", reason: "auth_plumbing" },
  body: t.Union([
    t.Object({ type: t.Literal("config") }, { additionalProperties: false }),
    t.Object({ type: t.Literal("revoke") }, { additionalProperties: false }),
    t.Object(
      {
        type: t.Literal("search"),
        registry,
        query: t.String({ minLength: 1, maxLength: 256 }),
      },
      { additionalProperties: false },
    ),
    t.Object(
      {
        type: t.Literal("format"),
        registry,
        id: t.String({ minLength: 1, maxLength: 64 }),
        formatId: t.Union([tSafeId("templateLookupFormat"), t.Null()]),
      },
      { additionalProperties: false },
    ),
  ]),
} as const;

// A dedicated bearer boundary, not an unauthenticated registry proxy. The
// ordinary session middleware intentionally does not recognize these keys.
type RegistryReply =
  | DesktopRegistryConfig
  | DesktopRegistrySearchResponse
  | { text: string }
  | { revoked: boolean };

export default createSafePublicHandler(
  config,
  async function* ({
    request,
    body,
    set,
  }): SafeHandlerGenerator<RegistryReply> {
    set.headers["cache-control"] = "no-store";
    const context = yield* Result.await(authorizeDesktopRegistry(request));
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
                message: "Could not disconnect registry search",
              }),
          }),
        );
        return Result.ok({ revoked: true });
      }
      case "config":
        return Result.ok(
          yield* Result.await(getDesktopRegistryConfig(context)),
        );
      case "search":
        return Result.ok(
          yield* Result.await(searchDesktopRegistry(context, body)),
        );
      case "format":
        return Result.ok(
          yield* Result.await(formatDesktopRegistry(context, body)),
        );
      default:
        body satisfies never;
        return panic("Unknown desktop registry request");
    }
  },
);
