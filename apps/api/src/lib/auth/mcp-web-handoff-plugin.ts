import type { BetterAuthPlugin } from "better-auth";
import {
  createAuthEndpoint,
  getAuthoritativeSessionFromCtx,
  originCheckMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { env } from "@/api/env";
import {
  canonicalHandoffPath,
  type createWebHandoffService,
  hasWebHandoffScopes,
  WEB_HANDOFF_CODE_PATTERN,
  webHandoffFailure,
} from "@/api/lib/auth/mcp-web-handoff";
import { MCP_HANDOFF_REDEEM_PATH } from "@/api/lib/auth/mcp-web-handoff-paths";
import { completeHandoffSession } from "@/api/lib/auth/mcp-web-handoff-session";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

const WEB_HANDOFF_ENDPOINT_FAILURE_SINK = failureSink({
  event: "mcp_web_handoff.endpoint_failed",
  expected: [],
});

type WebHandoffService = ReturnType<typeof createWebHandoffService>;
type HandoffPluginOptions = {
  service: () => WebHandoffService;
  now?: () => Date;
  textSessionMaxSeconds?: () => number;
};

const createListMcpHandoffSessionClientsEndpoint = (
  service: () => WebHandoffService,
) =>
  createAuthEndpoint(
    "/mcp-handoff/sessions",
    { method: "GET", requireHeaders: true, use: [sessionMiddleware] },
    async (ctx) => {
      ctx.setHeader(CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL);
      const result = await service().listSessionClients(
        brandPersistedUserId(ctx.context.session.user.id),
      );
      if (Result.isError(result)) {
        observeFailure(result.error, {
          sink: WEB_HANDOFF_ENDPOINT_FAILURE_SINK,
          ctx: { operation: "list_session_clients" },
        });
        ctx.setStatus(503);
        return ctx.json({ status: "unavailable" as const });
      }
      return ctx.json({ sessions: result.value });
    },
  );

export const createMcpWebHandoffPlugin = ({
  service,
  now = () => new Date(),
  textSessionMaxSeconds = () => env.MCP_WEB_HANDOFF_TEXT_SESSION_MAX_SECONDS,
}: HandoffPluginOptions) =>
  ({
    id: "mcp-web-handoff",
    endpoints: {
      redeemMcpWebHandoff: createAuthEndpoint(
        MCP_HANDOFF_REDEEM_PATH,
        {
          method: "POST",
          requireHeaders: true,
          body: v.strictObject({
            code: v.pipe(v.string(), v.maxLength(128)),
            path: v.pipe(v.string(), v.maxLength(4096)),
            confirmation: v.optional(v.literal("confirmed")),
          }),
          use: [originCheckMiddleware],
        },
        async (ctx) => {
          ctx.setHeader(CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL);
          ctx.setHeader("Referrer-Policy", "no-referrer");
          const refusalResponse = async () => {
            ctx.setStatus(403);
            return ctx.json({ status: "refused" as const });
          };
          // A browser-origin request is mandatory even when the instance allows other auth clients.
          const origin = ctx.headers.get("origin");
          if (!origin || !ctx.context.isTrustedOrigin(origin)) {
            return refusalResponse();
          }
          const currentService = service();
          const request = ctx.request;
          if (!request) {
            panic("Handoff endpoint requires HTTP dispatch");
          }
          const { code, path, confirmation } = ctx.body;
          if (!currentService.isEnabled()) {
            return refusalResponse();
          }
          const address =
            ctx.headers.get(AUTH_CLIENT_ADDRESS_HEADER) ?? "unknown";
          const admitted = await Result.tryPromise({
            try: async () => await currentService.admitRedeem(address),
            catch: webHandoffFailure(
              "redeem_admission",
              "Web handoff redemption is temporarily unavailable.",
            ),
          });
          if (Result.isError(admitted)) {
            observeFailure(admitted.error, {
              sink: WEB_HANDOFF_ENDPOINT_FAILURE_SINK,
              ctx: { operation: "admission" },
            });
            return refusalResponse();
          }
          if (!admitted.value) {
            return refusalResponse();
          }
          // Receipt-specific work is allowed only after address and global admission.
          const refuse = async (reason: string) => {
            const audited = await Result.tryPromise({
              try: async () =>
                await currentService.auditRefusal(code, reason, request),
              catch: webHandoffFailure(
                "refusal_audit",
                "Web handoff refusal could not be audited.",
              ),
            });
            if (Result.isError(audited)) {
              observeFailure(audited.error, {
                sink: WEB_HANDOFF_ENDPOINT_FAILURE_SINK,
                ctx: { operation: "refusal_audit" },
              });
            }
            return refusalResponse();
          };
          const originalCookies = ctx.responseHeaders.getSetCookie();
          const originalSession = ctx.context.newSession;
          const outcome = await Result.tryPromise({
            try: async () => {
              const canonical = canonicalHandoffPath(path);
              if (
                !WEB_HANDOFF_CODE_PATTERN.test(code) ||
                !canonical ||
                canonical !== path
              ) {
                return await refuse("input");
              }
              const grant = await currentService.inspect(code);
              if (!grant) {
                return await refuse("unavailable");
              }
              const userAdmitted = await Result.tryPromise({
                try: async () =>
                  await currentService.admitUser(
                    brandPersistedUserId(grant.userId),
                  ),
                catch: webHandoffFailure(
                  "user_admission",
                  "Web handoff redemption is temporarily unavailable.",
                ),
              });
              if (Result.isError(userAdmitted)) {
                observeFailure(userAdmitted.error, {
                  sink: WEB_HANDOFF_ENDPOINT_FAILURE_SINK,
                  ctx: { operation: "admission" },
                });
                return refusalResponse();
              }
              if (!userAdmitted.value) {
                return refusalResponse();
              }
              if (
                grant.handoff.consumedAt ||
                grant.handoff.expiresAt <= now() ||
                !hasWebHandoffScopes(grant.scopes)
              ) {
                return await refuse("unavailable");
              }
              if (!grant.handoff.allowedPaths.includes(canonical)) {
                return await refuse("path");
              }
              const existing = await getAuthoritativeSessionFromCtx(ctx);
              const sameUser = existing?.user.id === grant.userId;
              // A click link opens without a prompt only where its account is
              // already signed in; any other browser confirms the account first.
              if (
                (grant.handoff.kind === "text" || !sameUser) &&
                confirmation !== "confirmed"
              ) {
                await currentService.recordConfirmation(code, request);
                return ctx.json({
                  status: "needs_confirmation" as const,
                  email: grant.email,
                  organizationName: grant.organizationName,
                });
              }
              const consumed = await currentService.consume({
                code,
                path: canonical,
                request,
                ipAddress: address === "unknown" ? null : address,
                previousOrganizationId:
                  sameUser &&
                  typeof existing.session["activeOrganizationId"] === "string"
                    ? existing.session["activeOrganizationId"]
                    : null,
                complete: async (completionContext) =>
                  await completeHandoffSession({
                    ctx,
                    completionContext,
                    existing,
                    originalSession,
                    now,
                    textSessionMaxSeconds,
                  }),
              });
              if (!consumed) {
                return await refuse("unavailable");
              }
              return ctx.json({ status: "redeemed" as const });
            },
            catch: webHandoffFailure(
              "redeem",
              "Web handoff could not be redeemed.",
            ),
          });
          if (Result.isOk(outcome)) {
            return outcome.value;
          }
          // Rollback must also discard cookies and endpoint state prepared for the uncommitted session.
          ctx.responseHeaders.delete("set-cookie");
          for (const cookie of originalCookies) {
            ctx.responseHeaders.append("set-cookie", cookie);
          }
          ctx.context.setNewSession(originalSession);
          observeFailure(outcome.error, {
            sink: WEB_HANDOFF_ENDPOINT_FAILURE_SINK,
            ctx: { operation: "redeem" },
          });
          return await refuse("runtime");
        },
      ),
      listMcpHandoffSessionClients:
        createListMcpHandoffSessionClientsEndpoint(service),
    },
  }) satisfies BetterAuthPlugin;
