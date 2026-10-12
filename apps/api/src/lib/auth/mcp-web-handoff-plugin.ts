import type { BetterAuthPlugin } from "better-auth";
import {
  createAuthEndpoint,
  getAuthoritativeSessionFromCtx,
  originCheckMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { Result, panic } from "better-result";
import * as v from "valibot";

import { env } from "@/api/env";
import { captureError } from "@/api/lib/analytics/capture";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import {
  canonicalHandoffPath,
  getWebHandoffService,
  hasWebHandoffScopes,
  WEB_HANDOFF_CODE_PATTERN,
} from "@/api/lib/mcp-web-handoff";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

export const MCP_HANDOFF_REDEEM_PATH = "/mcp-handoff/redeem";
type WebHandoffService = ReturnType<typeof getWebHandoffService>;
type HandoffPluginOptions = {
  service?: () => WebHandoffService;
  now?: () => Date;
  textSessionMaxSeconds?: () => number;
};

export const createMcpWebHandoffPlugin = ({
  service = getWebHandoffService,
  now = () => new Date(),
  textSessionMaxSeconds = () => env.MCP_WEB_HANDOFF_TEXT_SESSION_MAX_SECONDS,
}: HandoffPluginOptions = {}) =>
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
          // A browser-origin request is mandatory even when the instance allows other auth clients.
          const origin = ctx.headers.get("origin");
          if (!origin || !ctx.context.isTrustedOrigin(origin)) {
            ctx.setStatus(403);
            return ctx.json({ status: "refused" as const });
          }
          const currentService = service();
          const request = ctx.request;
          if (!request) {
            panic("Handoff endpoint requires HTTP dispatch");
          }
          const { code, path, confirmation } = ctx.body;
          const refuse = async (reason: string) => {
            const audited = await Result.tryPromise(
              async () =>
                await currentService.auditRefusal(code, reason, request),
            );
            if (Result.isError(audited)) {
              captureError(audited.error, {
                operation: "mcp_web_handoff.refusal_audit",
              });
            }
            ctx.setStatus(403);
            return ctx.json({ status: "refused" as const });
          };
          if (!currentService.isEnabled()) {
            return await refuse("disabled");
          }
          const outcome = await Result.tryPromise(async () => {
            const address =
              ctx.headers.get(AUTH_CLIENT_ADDRESS_HEADER) ?? "unknown";
            if (!(await currentService.admitRedeem(address))) {
              return await refuse("budget");
            }
            const canonical = canonicalHandoffPath(path);
            if (
              !WEB_HANDOFF_CODE_PATTERN.test(code) ||
              !canonical ||
              canonical !== path
            ) {
              return await refuse("input");
            }
            const grant = await currentService.inspect(code);
            if (
              !grant ||
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
            if (
              (grant.handoff.kind === "text" ||
                (existing && existing.user.id !== grant.userId)) &&
              confirmation !== "confirmed"
            ) {
              return ctx.json({
                status: "needs_confirmation" as const,
                email: grant.email,
                organizationName: grant.organizationName,
              });
            }
            if (
              !(await currentService.admitUser(
                brandPersistedUserId(grant.userId),
              ))
            ) {
              return await refuse("budget");
            }
            const sameUser = existing?.user.id === grant.userId;
            const consumed = await currentService.consume({
              code,
              path: canonical,
              request,
              ipAddress: address === "unknown" ? null : address,
              sessionId: sameUser ? existing.session.id : null,
            });
            if (!consumed) {
              return await refuse("unavailable");
            }
            if (sameUser) {
              return ctx.json({ status: "redeemed" as const });
            }
            const account = await ctx.context.internalAdapter.findUserById(
              consumed.userId,
            );
            if (!account) {
              return await refuse("unavailable");
            }
            const absoluteDeadline =
              consumed.handoff.kind === "text"
                ? new Date(now().getTime() + textSessionMaxSeconds() * 1000)
                : null;
            const created = await ctx.context.internalAdapter.createSession(
              consumed.userId,
              false,
              {
                activeOrganizationId: consumed.organizationId,
                originConsentId: consumed.consentId,
                handoffAbsoluteExpiresAt: absoluteDeadline,
                lastSeenAt: now(),
                ...(absoluteDeadline ? { expiresAt: absoluteDeadline } : {}),
              },
            );
            await currentService.recordSession({
              handoffId: consumed.handoff.id,
              sessionId: created.id,
              request,
            });
            await setSessionCookie(ctx, { session: created, user: account });
            return ctx.json({ status: "redeemed" as const });
          });
          if (Result.isOk(outcome)) {
            return outcome.value;
          }
          captureError(outcome.error, {
            operation: "mcp_web_handoff.redeem",
          });
          return await refuse("runtime");
        },
      ),
      listMcpHandoffSessionClients: createAuthEndpoint(
        "/mcp-handoff/sessions",
        { method: "GET", requireHeaders: true, use: [sessionMiddleware] },
        async (ctx) => {
          ctx.setHeader(CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL);
          return ctx.json({
            sessions: await service().listSessionClients(
              brandPersistedUserId(ctx.context.session.user.id),
            ),
          });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
