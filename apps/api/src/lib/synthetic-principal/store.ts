import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, session, user } from "@/api/db/auth-schema";
import type { RootDatabase } from "@/api/db/root";
import { syntheticSessionControl } from "@/api/db/schema";
import { env } from "@/api/env";
import { seedDefaultSkills } from "@/api/lib/agent-skills/default-skills";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { revokeMonitoringSessions } from "@/api/lib/auth-artifacts";
import { sessionCookieName } from "@/api/lib/auth/auth-cookie-name";
import { acceptProfessionalUse } from "@/api/lib/auth/professional-use";
import { decidePinnedSessionLifetime } from "@/api/lib/auth/session-lifetime";
import { createSignedSessionCookieValue } from "@/api/lib/auth/signed-session-cookie";
import { createSafeId } from "@/api/lib/branded-types";
import { readAccountProfileForExport } from "@/api/lib/db/account-row";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { SYNTHETIC_SESSION_CONTROL_TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transition } from "@/api/lib/db/transitions";
import { logger } from "@/api/lib/observability/logger";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { recordSystemAudit } from "@/api/lib/system-audit/record";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";

import {
  SYNTHETIC_PRINCIPAL,
  SYNTHETIC_SESSION_CONTROL_ID,
  SYNTHETIC_SESSION_PREFIX,
} from "./constants";

type MintSyntheticSessionOptions = {
  keyLabel: string;
  requestId: string | undefined;
  userAgent: string | null;
};

export const createSyntheticSessionStore = (
  database: Pick<RootDatabase, "transaction" | "select">,
) => {
  const mintSyntheticSession = async ({
    keyLabel,
    requestId,
    userAgent,
  }: MintSyntheticSessionOptions) => {
    const minted = await withAggregateTransaction(database, async (tx) => {
      const now = new Date();
      // Updating the singleton locks it through commit, including provisioning and the audit write.
      const [control] = await tx
        .update(syntheticSessionControl)
        .set({ updatedAt: now })
        .where(eq(syntheticSessionControl.id, SYNTHETIC_SESSION_CONTROL_ID))
        .returning({ status: syntheticSessionControl.status });
      if (control?.status !== "enabled") {
        return null;
      }
      const principal = SYNTHETIC_PRINCIPAL;
      const existingAccount = await readAccountProfileForExport(
        tx,
        brandPersistedUserId(principal.user.id),
      );
      if (existingAccount === undefined) {
        await tx.insert(user).values({
          ...principal.user,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        });
      }
      await tx
        .insert(organization)
        .values({
          ...principal.org,
          createdAt: now,
        })
        .onConflictDoNothing({ target: organization.id });
      await recordNewOrganizationAccessState(tx, {
        organizationId: brandPersistedOrganizationId(principal.org.id),
        now,
      });
      const insertedMembers = await tx
        .insert(member)
        .values({
          id: principal.memberId,
          organizationId: principal.org.id,
          userId: principal.user.id,
          role: "owner",
          createdAt: now,
        })
        .onConflictDoNothing({ target: member.id })
        .returning({ id: member.id });
      if (insertedMembers.length > 0) {
        await seedDefaultSkills({
          organizationId: brandPersistedOrganizationId(principal.org.id),
          userId: brandPersistedUserId(principal.user.id),
          tx,
        });
      }
      await acceptProfessionalUse({
        tx,
        userId: brandPersistedUserId(principal.user.id),
      });

      const token = Bun.randomUUIDv7();
      const id = `${SYNTHETIC_SESSION_PREFIX}${token}`;
      const lifetime =
        decidePinnedSessionLifetime({ id, createdAt: now }) ??
        panic("Dedicated session id did not select its fixed lifetime");
      await tx.insert(session).values({
        id,
        token,
        ...lifetime,
        userId: SYNTHETIC_PRINCIPAL.user.id,
        activeOrganizationId: SYNTHETIC_PRINCIPAL.org.id,
        createdAt: now,
        updatedAt: now,
        ipAddress: "synthetic-monitor",
        userAgent: "stella-synthetic/prod",
      });
      const audit = createBackgroundAuditRecorder({
        organizationId: brandPersistedOrganizationId(
          SYNTHETIC_PRINCIPAL.org.id,
        ),
        workspaceId: null,
        userId: brandPersistedUserId(SYNTHETIC_PRINCIPAL.user.id),
        execution: {
          performer: { type: "service", id: "synthetic-session", name: null },
          trigger: { type: "system", source: "synthetic-session" },
        },
      });
      await audit(tx, {
        action: AUDIT_ACTION.SYNTHETIC_SESSION_MINTED,
        resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
        resourceId: SYNTHETIC_PRINCIPAL.org.id,
        metadata: {
          keyLabel,
          requestId: requestId ?? null,
          userAgent,
          expiresAt: lifetime.expiresAt.toISOString(),
        },
      });
      return {
        cookieName: sessionCookieName(),
        cookieValue: createSignedSessionCookieValue(
          token,
          env.BETTER_AUTH_SECRET,
        ),
        expiresAt: lifetime.expiresAt.toISOString(),
      };
    });
    if (minted) {
      logger.warn("synthetic.session_minted", {
        "synthetic.key_label": keyLabel,
        "synthetic.request_id": requestId,
        "synthetic.session_expires_at": minted.expiresAt,
      });
    }
    return minted;
  };

  const revokeSyntheticSessions = async () =>
    await withAggregateTransaction(database, async (tx) => {
      const controlTransition = await transition({
        tx,
        spec: SYNTHETIC_SESSION_CONTROL_TRANSITIONS,
        id: SYNTHETIC_SESSION_CONTROL_ID,
        options: {
          from: ["enabled"],
          to: "revoked",
          set: { updatedAt: new Date() },
        },
        recordTransitionAuditEvent: async () => await Promise.resolve(),
      });
      const { deletedSessions, deletedRoomTokens } =
        await revokeMonitoringSessions({
          tx,
          userId: brandPersistedUserId(SYNTHETIC_PRINCIPAL.user.id),
          recordAuditEvent: async (counts) => {
            await recordSystemAudit(tx, "system:monitoring-session-revoke", {
              subject: createSafeId<"systemScriptRun">(),
              counts: {
                revokedControls:
                  controlTransition.type === "transitioned" ? 1 : 0,
                ...counts,
              },
            });
          },
        });
      return { status: "revoked", deletedSessions, deletedRoomTokens };
    });

  const getSyntheticSessionStatus = async () => {
    const [control] = await database
      .select({
        status: syntheticSessionControl.status,
        updatedAt: syntheticSessionControl.updatedAt,
      })
      .from(syntheticSessionControl)
      .where(eq(syntheticSessionControl.id, SYNTHETIC_SESSION_CONTROL_ID))
      .limit(1);
    return control ?? { status: "missing", updatedAt: null };
  };

  return {
    mintSyntheticSession,
    revokeSyntheticSessions,
    getSyntheticSessionStatus,
  };
};
