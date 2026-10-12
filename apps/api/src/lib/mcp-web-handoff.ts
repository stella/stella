import { Result } from "better-result";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { randomBytes } from "node:crypto";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@stll/api-contract/mcp";
import { canonicalRedirectPath } from "@stll/api-contract/redirect-path";
import { sha256Hex } from "@stll/sha256/bun";

import {
  member,
  oauthClient,
  oauthConsent,
  organization,
  session,
  user,
} from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  mcpWebHandoff,
  MCP_WEB_HANDOFF_MAX_PATHS,
  type MCP_WEB_HANDOFF_KINDS,
} from "@/api/db/schema/mcp-web-handoff";
import { env } from "@/api/env";
import { captureError } from "@/api/lib/analytics/capture";
import {
  createAuditRecorder,
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { logger } from "@/api/lib/observability/logger";
import { MCP_RATE_LIMITS } from "@/api/lib/rate-limit/budget-config";
import type { RateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";
import {
  brandPersistedUserId,
  brandPersistedOrganizationId,
} from "@/api/lib/safe-id-boundaries";

export const WEB_HANDOFF_TTL_MS = {
  text: 10 * 60 * 1000,
  click: 60 * 1000,
} as const satisfies Record<(typeof MCP_WEB_HANDOFF_KINDS)[number], number>;
export const WEB_HANDOFF_CODE_PATTERN = /^sh1_[A-Za-z0-9_-]{43}$/u;
type HandoffKind = (typeof MCP_WEB_HANDOFF_KINDS)[number];
export type WebHandoffMintContext = {
  credentialType: "oauth" | "api-key" | "anonymous";
  grantedScopes: readonly string[];
  clientId: string | null;
  consentId: string | null;
  userId: string | null;
  organizationId: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  request?: Request;
};

type HandoffDatabase = Pick<
  PgAsyncDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update" | "transaction"
>;
type HandoffBudgetContext = Pick<RateLimitContext, "increment" | "complete">;
type HandoffServiceOptions = {
  db: HandoffDatabase;
  budget: HandoffBudgetContext;
  now?: () => Date;
  enabled: () => boolean;
  textEnabled: () => boolean;
};

export const canonicalHandoffPath = (path: string): string | undefined => {
  const canonical = canonicalRedirectPath(path);
  if (!canonical || canonical.length > 4096) {
    return undefined;
  }
  // Handoff credentials are accepted only by application pages, never API or sign-in flows.
  const pathname = new URL(canonical, "https://redirect.invalid").pathname;
  const decoded = Result.try(() => decodeURIComponent(pathname)).unwrapOr("");
  if (!decoded || /^\/(?:api|v1|auth)(?:\/|$)/iu.test(decoded)) {
    return undefined;
  }
  return canonical;
};

export const hasWebHandoffScopes = (scopes: readonly string[]) =>
  MCP_DEFAULT_RESOURCE_SCOPES.every((scope) => scopes.includes(scope));

const auditBindings = (
  grant: { userId: string; organizationId: string },
  request: Request,
) => ({
  userId: brandPersistedUserId(grant.userId),
  organizationId: brandPersistedOrganizationId(grant.organizationId),
  workspaceId: null,
  request,
  server: null,
});
const grantColumns = {
  consentId: oauthConsent.id,
  userId: user.id,
  organizationId: organization.id,
  clientId: oauthClient.clientId,
  scopes: oauthConsent.scopes,
  email: user.email,
  organizationName: organization.name,
  clientName: oauthClient.name,
};
const liveGrant = (database: Pick<HandoffDatabase, "select">) =>
  database
    .select(grantColumns)
    .from(oauthConsent)
    .innerJoin(
      oauthClient,
      and(
        eq(oauthClient.clientId, oauthConsent.clientId),
        eq(oauthClient.disabled, false),
      ),
    )
    .innerJoin(
      user,
      and(eq(user.id, oauthConsent.userId), isNull(user.deletedAt)),
    )
    .innerJoin(
      member,
      and(
        eq(member.userId, user.id),
        eq(member.organizationId, oauthConsent.referenceId),
      ),
    )
    .innerJoin(organization, eq(organization.id, member.organizationId));

export const createWebHandoffService = ({
  db,
  budget,
  now = () => new Date(),
  textEnabled,
  enabled,
}: HandoffServiceOptions) => {
  const consumeBudget = async (
    key: string,
    limit: { max: number; windowMs: number },
  ) => {
    const counterKey = `mcp-web-handoff:${sha256Hex(key)}`;
    const counter = await budget.increment(counterKey, limit.windowMs);
    await budget.complete(counterKey);
    return counter.count <= limit.max;
  };
  const mint = async (
    ctx: WebHandoffMintContext,
    paths: readonly string[],
    kind: HandoffKind,
  ): Promise<string | null> => {
    const { credentialType, userId, organizationId, clientId, consentId } = ctx;
    if (
      !enabled() ||
      credentialType !== "oauth" ||
      !hasWebHandoffScopes(ctx.grantedScopes) ||
      !userId ||
      !organizationId ||
      !clientId ||
      !consentId ||
      (kind === "text" && !textEnabled())
    ) {
      return null;
    }
    const allowedPaths = [...new Set(paths.map(canonicalHandoffPath))];
    if (
      allowedPaths.length === 0 ||
      allowedPaths.length > MCP_WEB_HANDOFF_MAX_PATHS ||
      allowedPaths.includes(undefined)
    ) {
      return null;
    }
    const normalizedPaths = allowedPaths.filter((path) => path !== undefined);
    if (
      !(await consumeBudget(
        `mint:${userId}:${consentId}`,
        MCP_RATE_LIMITS.handoffMint,
      ))
    ) {
      return null;
    }
    return await withAggregateTransaction(db, async (tx) => {
      const grant = (
        await liveGrant(tx)
          .where(
            and(
              eq(oauthConsent.id, consentId),
              eq(oauthConsent.userId, userId),
              eq(oauthConsent.clientId, clientId),
              eq(oauthConsent.referenceId, organizationId),
            ),
          )
          .limit(1)
      ).at(0);
      if (!grant || !hasWebHandoffScopes(grant.scopes)) {
        return null;
      }
      const code = `sh1_${randomBytes(32).toString("base64url")}`;
      const id = Bun.randomUUIDv7();
      const createdAt = now();
      await tx.insert(mcpWebHandoff).values({
        id,
        codeHash: sha256Hex(code),
        userId: grant.userId,
        organizationId: grant.organizationId,
        oauthClientId: grant.clientId,
        consentId: grant.consentId,
        allowedPaths: normalizedPaths,
        kind,
        expiresAt: new Date(createdAt.getTime() + WEB_HANDOFF_TTL_MS[kind]),
        createdAt,
        createdIpHash: ctx.ipAddress ? sha256Hex(ctx.ipAddress) : null,
        uaHash: ctx.userAgent ? sha256Hex(ctx.userAgent) : null,
      });
      const audit = createAuditRecorder(
        auditBindings(grant, ctx.request ?? new Request(env.FRONTEND_URL)),
      );
      await audit(tx, {
        action: AUDIT_ACTION.MCP_WEB_HANDOFF_ISSUED,
        resourceType: AUDIT_RESOURCE_TYPE.MCP_WEB_HANDOFF,
        resourceId: id,
        metadata: {
          pathCount: normalizedPaths.length,
          clientId: grant.clientId,
          kind,
        },
      });
      return code;
    });
  };

  return {
    mint,
    isEnabled: enabled,
    ...createHandoffRedemption({ db, now, consumeBudget, enabled }),
  };
};

const inspectWebHandoff = async (db: HandoffDatabase, code: string) => {
  const grant = (
    await db
      .select({ handoff: mcpWebHandoff, ...grantColumns })
      .from(mcpWebHandoff)
      .innerJoin(
        oauthConsent,
        and(
          eq(oauthConsent.id, mcpWebHandoff.consentId),
          eq(oauthConsent.userId, mcpWebHandoff.userId),
          eq(oauthConsent.clientId, mcpWebHandoff.oauthClientId),
          eq(oauthConsent.referenceId, mcpWebHandoff.organizationId),
        ),
      )
      .innerJoin(
        oauthClient,
        and(
          eq(oauthClient.clientId, oauthConsent.clientId),
          eq(oauthClient.disabled, false),
        ),
      )
      .innerJoin(
        user,
        and(eq(user.id, mcpWebHandoff.userId), isNull(user.deletedAt)),
      )
      .innerJoin(
        member,
        and(
          eq(member.userId, user.id),
          eq(member.organizationId, mcpWebHandoff.organizationId),
        ),
      )
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(mcpWebHandoff.codeHash, sha256Hex(code)))
      .limit(1)
  ).at(0);
  return grant ?? null;
};

type HandoffRedemptionOptions = {
  enabled: () => boolean;
  db: HandoffDatabase;
  now: () => Date;
  consumeBudget: (
    key: string,
    limit: { max: number; windowMs: number },
  ) => Promise<boolean>;
};
const createHandoffRedemption = ({
  db,
  now,
  consumeBudget,
  enabled,
}: HandoffRedemptionOptions) => {
  const auditRefusal = async (
    code: string,
    reason: string,
    request: Request,
  ) => {
    const row = (
      await db
        .select()
        .from(mcpWebHandoff)
        .where(eq(mcpWebHandoff.codeHash, sha256Hex(code)))
        .limit(1)
    ).at(0);
    if (!row) {
      logger.info("mcp_web_handoff.refused", { reason });
      return;
    }
    await withAggregateTransaction(db, async (tx) => {
      const audit = createAuditRecorder(auditBindings(row, request));
      await audit(tx, {
        action: AUDIT_ACTION.MCP_WEB_HANDOFF_REFUSED,
        resourceType: AUDIT_RESOURCE_TYPE.MCP_WEB_HANDOFF,
        resourceId: row.id,
        metadata: { reason },
      });
    });
  };
  const consume = async ({
    code,
    path,
    request,
    ipAddress,
    sessionId,
    previousOrganizationId,
  }: {
    code: string;
    path: string;
    request: Request;
    ipAddress: string | null;
    sessionId: string | null;
    previousOrganizationId: string | null;
  }) =>
    await withAggregateTransaction(db, async (tx) => {
      if (!enabled()) {
        return null;
      }
      const grantedScopes = sql`ARRAY[${sql.join(
        MCP_DEFAULT_RESOURCE_SCOPES.map((scope) => sql`${scope}`),
        sql`, `,
      )}]::text[]`;
      const grantIsLive = exists(
        liveGrant(tx).where(
          and(
            eq(oauthConsent.id, mcpWebHandoff.consentId),
            eq(oauthConsent.userId, mcpWebHandoff.userId),
            eq(oauthConsent.referenceId, mcpWebHandoff.organizationId),
            eq(oauthConsent.clientId, mcpWebHandoff.oauthClientId),
            sql`${oauthConsent.scopes} @> ${grantedScopes}`,
          ),
        ),
      );
      const consumed = (
        await tx
          .update(mcpWebHandoff)
          .set({
            consumedAt: now(),
            consumedIpHash: ipAddress ? sha256Hex(ipAddress) : null,
            consumedSessionId: sessionId,
          })
          .where(
            and(
              eq(mcpWebHandoff.codeHash, sha256Hex(code)),
              isNull(mcpWebHandoff.consumedAt),
              grantIsLive,
              sql`${mcpWebHandoff.expiresAt} > ${now()}::timestamptz`,
              sql`${path} = ANY(${mcpWebHandoff.allowedPaths})`,
            ),
          )
          .returning()
      ).at(0);
      if (!consumed) {
        return null;
      }
      const audit = createAuditRecorder(auditBindings(consumed, request));
      await audit(tx, {
        action: AUDIT_ACTION.MCP_WEB_HANDOFF_REDEEMED,
        resourceType: AUDIT_RESOURCE_TYPE.MCP_WEB_HANDOFF,
        resourceId: consumed.id,
        metadata: {
          kind: consumed.kind,
          clientId: consumed.oauthClientId,
          previousOrganizationId,
          newOrganizationId: consumed.organizationId,
        },
      });
      return {
        handoff: consumed,
        userId: consumed.userId,
        organizationId: consumed.organizationId,
        consentId: consumed.consentId,
      };
    });
  const admitRedeem = async (address: string) =>
    (await consumeBudget(
      "redeem:global",
      MCP_RATE_LIMITS.handoffRedeemGlobal,
    )) &&
    (await consumeBudget(
      `redeem:address:${address}`,
      MCP_RATE_LIMITS.handoffRedeemAddress,
    ));
  const admitUser = async (userId: SafeId<"user">) =>
    await consumeBudget(
      `redeem:user:${userId}`,
      MCP_RATE_LIMITS.handoffRedeemUser,
    );
  const recordSession = async ({
    handoffId,
    sessionId,
    request,
  }: {
    handoffId: string;
    sessionId: string;
    request: Request;
  }) => {
    await withAggregateTransaction(db, async (tx) => {
      const completed = (
        await tx
          .update(mcpWebHandoff)
          .set({ consumedSessionId: sessionId })
          .where(eq(mcpWebHandoff.id, handoffId))
          .returning()
      ).at(0);
      if (!completed) {
        return;
      }
      const audit = createAuditRecorder(auditBindings(completed, request));
      await audit(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.MCP_WEB_HANDOFF,
        resourceId: completed.id,
        metadata: { sessionId },
      });
    });
  };
  const listSessionClients = async (userId: SafeId<"user">) =>
    await db
      .select({
        id: session.id,
        clientName: sql<string>`COALESCE(${oauthClient.name}, ${oauthClient.clientId})`,
      })
      .from(session)
      .innerJoin(oauthConsent, eq(oauthConsent.id, session.originConsentId))
      .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
      .where(
        and(
          eq(session.userId, userId),
          sql`${session.expiresAt} > ${now()}::timestamptz`,
        ),
      )
      .limit(100);
  return {
    inspect: async (code: string) => await inspectWebHandoff(db, code),
    consume,
    auditRefusal,
    admitRedeem,
    admitUser,
    recordSession,
    listSessionClients,
  };
};

let service: ReturnType<typeof createWebHandoffService> | undefined;
export const getWebHandoffService = () =>
  (service ??= createWebHandoffService({
    db: rootDb,
    budget: new RedisRateLimitContext({ failurePolicy: "fail_closed" }),
    enabled: () => env.MCP_WEB_HANDOFF_MINT_ENABLED,
    textEnabled: () => env.MCP_WEB_HANDOFF_TEXT_ENABLED === "1",
  }));
export const mintWebHandoff = async (
  ctx: WebHandoffMintContext,
  paths: readonly string[],
  kind: HandoffKind,
) => {
  const outcome = await Result.tryPromise(async () =>
    getWebHandoffService().mint(ctx, paths, kind),
  );
  if (Result.isOk(outcome)) {
    return outcome.value;
  }
  captureError(outcome.error, {
    operation: "mcp_web_handoff.mint",
  });
  return null;
};
