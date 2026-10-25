import { defaultKeyHasher } from "@better-auth/api-key";
import { generateRandomString } from "better-auth/crypto";
import { panic, Result } from "better-result";
import type { InferOk } from "better-result";
import { and, desc, eq, gt } from "drizzle-orm";

import { apikey, member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import { organizationSettings } from "@/api/db/schema";
import {
  mintMachineApiKey,
  toMachineApiKeySummary,
  validateGrantablePermissions,
} from "@/api/handlers/api-keys/mint";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { CredentialIssuanceFence } from "@/api/lib/auth-artifacts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  API_KEY_KIND,
  API_KEY_POLICY,
  MACHINE_API_KEY_LENGTH,
  MACHINE_API_KEY_NAME_MAX_LENGTH,
  MACHINE_API_KEY_PREFIX,
  MACHINE_API_KEY_RATE_LIMIT,
  MACHINE_API_KEY_START_LENGTH,
  PERSONAL_API_KEY_ACTIVE_LIMIT,
  PERSONAL_API_KEY_AUDIENCES,
  PERSONAL_API_KEY_DEFAULT_SCOPES,
  PERSONAL_API_KEY_SCOPES,
} from "@/api/lib/machine-api-key-config";
import type {
  PERSONAL_API_KEY_POLICIES,
  PersonalApiKeyScope,
} from "@/api/lib/machine-api-key-config";
import {
  machineApiKeyColumns,
  machineApiKeyCursor,
} from "@/api/lib/machine-api-key-queries";
import {
  apiKeyKindScope,
  machineApiKeyOrganizationScope,
} from "@/api/lib/machine-api-key-scope";
import { personalApiKeyPermissions } from "@/api/lib/machine-api-keys/personal-policy";
import { isMemberRole } from "@/api/lib/member-roles";
import { createCursorPage } from "@/api/lib/pagination";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

const personalScope = (organizationId: SafeId<"organization">) =>
  and(
    machineApiKeyOrganizationScope(organizationId),
    apiKeyKindScope(API_KEY_KIND.personal),
  );
const keyNotFound = () =>
  new HandlerError({ status: 404, message: "API key not found" });

type Principal = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
/**
 * Issuing a key needs the caller's session to be live under the account's
 * credential fence, so an access reset cannot miss a key minted concurrently.
 * A credential without a browser session (`null`) cannot issue one.
 * Revocation and policy changes only manage existing keys.
 */
type KeyMutationAuthority =
  { type: "issue"; sessionId: string | null } | { type: "manage" };
const MANAGE = { type: "manage" } as const satisfies KeyMutationAuthority;
type CreateApiKey = Parameters<typeof mintMachineApiKey>[1];

/**
 * Inserts a key with the plugin's generator and hasher contract, inside the
 * transaction that holds the owner's credential fence. An access reset locks
 * the same fence and sweeps keys in its own transaction, so a key written here
 * either commits before the sweep, which revokes it, or finds its session gone.
 * Every key, personal or machine, is written through this writer.
 */
const createApiKeyUnderFence =
  (fence: CredentialIssuanceFence, now: Date): CreateApiKey =>
  async ({ body }) => {
    if (body.userId !== fence.userId) {
      return panic("An API key is issued only to the fenced account");
    }
    const key = `${MACHINE_API_KEY_PREFIX}${generateRandomString(MACHINE_API_KEY_LENGTH, "a-z", "A-Z")}`;
    const id = Bun.randomUUIDv7();
    const start = key.slice(0, MACHINE_API_KEY_START_LENGTH);
    const expiresAt = new Date(now.getTime() + body.expiresIn * 1000);
    // audit: skip - every caller records the key's receipt in this fenced transaction
    await fence.tx.insert(apikey).values({
      id,
      configId: body.configId,
      referenceId: body.userId,
      name: body.name,
      prefix: MACHINE_API_KEY_PREFIX,
      start,
      key: await defaultKeyHasher(key),
      metadata: JSON.stringify(body.metadata),
      permissions: JSON.stringify(body.permissions),
      expiresAt,
      createdAt: now,
      updatedAt: now,
      enabled: true,
      rateLimitEnabled: MACHINE_API_KEY_RATE_LIMIT.enabled,
      rateLimitMax: MACHINE_API_KEY_RATE_LIMIT.maxRequests,
      rateLimitTimeWindow: MACHINE_API_KEY_RATE_LIMIT.timeWindow,
    });
    return { id, start, key, expiresAt };
  };

const signInAgainToIssue = () =>
  new HandlerError({
    status: 401,
    message: "Sign in again to create an API key",
  });
/** An issuing mutation aborts before `run` unless it holds the fence. */
const issuingFence = (fence: CredentialIssuanceFence | null) =>
  fence ?? panic("An issuing key mutation runs only under its fence");
type MutationOptions = Principal & {
  recordAuditEvent: AuditRecorder;
  database?: Pick<typeof rootDb, "transaction" | "select">;
};

// The auth table denies scoped-role access. These owner-level operations always
// retain the organization and owner predicates; the role is rechecked under lock.
const mutatePersonalKeys = async <T>(
  options: MutationOptions & { authority: KeyMutationAuthority },
  run: (context: {
    tx: Transaction;
    memberRole: AuthorizedMemberRole;
    /** Held for issuing authority only; issuers write keys through it. */
    fence: CredentialIssuanceFence | null;
  }) => Promise<T>,
) =>
  Result.tryPromise({
    try: async () =>
      (options.database ?? rootDb).transaction(async (tx) => {
        // The account fence ranks before the organization row.
        const fence =
          options.authority.type === "issue"
            ? await CredentialIssuanceFence.hold(tx, {
                userId: options.userId,
                sessionId: options.authority.sessionId,
              })
            : null;
        if (options.authority.type === "issue" && fence === null) {
          return abortTransaction(signInAgainToIssue());
        }
        // All mint/rotate/policy changes take this lock next. The active limit and
        // policy decision therefore serialize across processes, including first use.
        const [org] = await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, options.organizationId))
          .for("no key update");
        if (!org) {
          return abortTransaction(keyNotFound());
        }
        const [membership] = await tx
          .select({ role: member.role })
          .from(member)
          .where(
            and(
              eq(member.organizationId, options.organizationId),
              eq(member.userId, options.userId),
            ),
          )
          .for("update");
        if (!membership || !isMemberRole(membership.role)) {
          return abortTransaction(keyNotFound());
        }
        return run({
          tx,
          memberRole: sessionMemberRole(membership.role),
          fence,
        });
      }),
    catch: (error: unknown) =>
      HandlerError.is(error)
        ? error
        : new HandlerError({
            status: 500,
            message: "Could not manage personal API keys",
            cause: error,
          }),
  });

export const readPersonalApiKeyPolicy = async (
  organizationId: SafeId<"organization">,
  database: Pick<typeof rootDb, "select"> = rootDb,
) => {
  const [settings] = await database
    .select({ policy: organizationSettings.personalApiKeyPolicy })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return settings?.policy ?? "enabled";
};

type MintPersonalKeyOptions = MutationOptions & {
  sessionId: string | null;
  name: string;
  scopes?: PersonalApiKeyScope[] | undefined;
  expiresInDays?: number | undefined;
  audience?: (typeof PERSONAL_API_KEY_AUDIENCES)[number] | undefined;
  permissionCeiling?: Record<string, string[]>;
};

type MintPersonalKeyInTransactionOptions = {
  options: MintPersonalKeyOptions;
  memberRole: AuthorizedMemberRole;
};
const mintPersonalKey = async (
  fence: CredentialIssuanceFence,
  { options, memberRole }: MintPersonalKeyInTransactionOptions,
) => {
  const { tx } = fence;
  if (
    (await readPersonalApiKeyPolicy(options.organizationId, tx)) !== "enabled"
  ) {
    return abortTransaction(
      new HandlerError({
        status: 403,
        message: "Personal API keys are disabled by your organization",
      }),
    );
  }
  const now = new Date();
  const active = await tx
    .select({ id: apikey.id })
    .from(apikey)
    .where(
      and(
        personalScope(options.organizationId),
        eq(apikey.referenceId, options.userId),
        eq(apikey.enabled, true),
        gt(apikey.expiresAt, now),
      ),
    )
    .offset(PERSONAL_API_KEY_ACTIVE_LIMIT - 1)
    .limit(1);
  if (active.length > 0) {
    return abortTransaction(
      new HandlerError({
        status: 409,
        message: "Revoke an active personal API key before creating another",
      }),
    );
  }
  const grantedPermissions = personalApiKeyPermissions(
    memberRole,
    options.scopes ?? PERSONAL_API_KEY_DEFAULT_SCOPES,
  );
  const permissions = Object.fromEntries(
    Object.entries(grantedPermissions)
      .map(
        ([resource, actions]) =>
          [
            resource,
            options.permissionCeiling === undefined
              ? actions
              : actions.filter((action) =>
                  options.permissionCeiling?.[resource]?.includes(action),
                ),
          ] satisfies [string, string[]],
      )
      .filter(([, actions]) => actions.length > 0),
  );
  const minted = await mintMachineApiKey(
    {
      kind: API_KEY_KIND.personal,
      name: options.name,
      scopes: options.scopes ?? [...PERSONAL_API_KEY_DEFAULT_SCOPES],
      permissions,
      expiresInDays: options.expiresInDays,
      audience: options.audience ?? "default",
      userId: options.userId,
      organizationId: options.organizationId,
    },
    // Insertion and its audit receipt share the active-key reservation's
    // transaction, which holds the account's credential fence.
    createApiKeyUnderFence(fence, now),
  );
  if (minted.isErr()) {
    return abortTransaction(minted.error);
  }
  const summary = minted.value;
  await options.recordAuditEvent(tx, {
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY,
    resourceId: summary.id,
    metadata: {
      name: summary.name,
      scopes: summary.scopes,
      audience: summary.audience,
    },
  });
  return {
    id: summary.id,
    name: summary.name,
    start: summary.start,
    key: summary.key,
    scopes: options.scopes ?? [...PERSONAL_API_KEY_DEFAULT_SCOPES],
    audience: options.audience ?? PERSONAL_API_KEY_AUDIENCES[0],
    expiresAt: summary.expiresAt,
  };
};

export const createPersonalApiKey = async (options: MintPersonalKeyOptions) =>
  mutatePersonalKeys(
    { ...options, authority: { type: "issue", sessionId: options.sessionId } },
    async ({ memberRole, fence }) =>
      mintPersonalKey(issuingFence(fence), { options, memberRole }),
  );

type MintedMachineApiKey = InferOk<
  Awaited<ReturnType<typeof mintMachineApiKey>>
>;
type IssueMachineApiKeyOptions = Parameters<typeof mintMachineApiKey>[0] & {
  /** The issuing browser session; a credential without one cannot issue. */
  sessionId: string | null;
  recordAuditEvent: AuditRecorder;
  /** The receipt recorded with the key, in the issuing transaction. */
  auditEvent: (minted: MintedMachineApiKey) => Parameters<AuditRecorder>[1];
  database?: MutationOptions["database"];
};

/**
 * Mints a machine key through the same mutation as a personal key: under the
 * account's credential fence and the organization's key lock, with membership
 * rechecked and the receipt recorded in that transaction. Neither kind of key
 * can therefore outlive a concurrent access reset.
 */
export const issueMachineApiKey = async ({
  sessionId,
  recordAuditEvent,
  auditEvent,
  database,
  ...options
}: IssueMachineApiKeyOptions) =>
  mutatePersonalKeys(
    {
      organizationId: options.organizationId,
      userId: options.userId,
      recordAuditEvent,
      database,
      authority: { type: "issue", sessionId },
    },
    async ({ fence, memberRole }) => {
      const issuing = issuingFence(fence);
      // The role locked in this transaction decides what the key may carry: a
      // caller demoted after its request was validated cannot keep the grant.
      const grantable = validateGrantablePermissions({
        memberRole,
        requested: options.permissions,
      });
      if (grantable.type === "error") {
        return abortTransaction(grantable.error);
      }
      const minted = await mintMachineApiKey(
        options,
        createApiKeyUnderFence(issuing, new Date()),
      );
      if (minted.isErr()) {
        return abortTransaction(minted.error);
      }
      await recordAuditEvent(issuing.tx, auditEvent(minted.value));
      return minted.value;
    },
  );

type KeyOptions = MutationOptions & { keyId: string };
const loadPersonalKeyRow = async (
  tx: Transaction,
  options: KeyOptions & { access: "own" | "organization" },
) => {
  const [row] = await tx
    .select(machineApiKeyColumns)
    .from(apikey)
    .where(
      and(
        personalScope(options.organizationId),
        eq(apikey.id, options.keyId),
        options.access === "own"
          ? eq(apikey.referenceId, options.userId)
          : undefined,
      ),
    )
    .for("update");
  if (!row) {
    return abortTransaction(keyNotFound());
  }
  return row;
};

const loadPersonalKey = async (
  tx: Transaction,
  options: KeyOptions & { access: "own" | "organization" },
) => {
  const row = await loadPersonalKeyRow(tx, options);
  const key = toMachineApiKeySummary(row);
  if (!key || key.kind !== API_KEY_KIND.personal) {
    return abortTransaction(keyNotFound());
  }
  return { ...key, expiresAt: row.expiresAt };
};

export const revokePersonalApiKey = async (
  options: KeyOptions & { access: "own" | "organization" },
) =>
  mutatePersonalKeys(
    { ...options, authority: MANAGE },
    async ({ tx, memberRole }) => {
      if (
        options.access === "organization" &&
        !hasMemberPermission(memberRole, { organizationSettings: ["update"] })
      ) {
        return abortTransaction(
          new HandlerError({
            status: 403,
            message: "Organization administrator access required",
          }),
        );
      }
      const key = await loadPersonalKeyRow(tx, options);
      if (key.enabled) {
        await tx
          .update(apikey)
          .set({ enabled: false, updatedAt: new Date() })
          .where(
            and(personalScope(options.organizationId), eq(apikey.id, key.id)),
          );
        await options.recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY,
          resourceId: key.id,
          metadata: {
            name: key.name,
            reason: "revoked",
            ownerUserId: key.referenceId,
          },
        });
      }
      return { id: key.id, revoked: true };
    },
  );

export const rotatePersonalApiKey = async (
  options: KeyOptions & {
    sessionId: string | null;
    expiresInDays?: number | undefined;
  },
) =>
  mutatePersonalKeys(
    { ...options, authority: { type: "issue", sessionId: options.sessionId } },
    async ({ tx, memberRole, fence }) => {
      const key = await loadPersonalKey(tx, { ...options, access: "own" });
      if (
        !key.enabled ||
        key.expiresAt === null ||
        key.expiresAt <= new Date()
      ) {
        return abortTransaction(
          new HandlerError({
            status: 409,
            message: "API key is revoked or expired",
          }),
        );
      }
      // Disable inside this transaction before reserving the replacement slot.
      // A failed mint or audit rolls both operations back.
      await tx
        .update(apikey)
        .set({ enabled: false, updatedAt: new Date() })
        .where(
          and(personalScope(options.organizationId), eq(apikey.id, key.id)),
        );
      const replacement = await mintPersonalKey(issuingFence(fence), {
        options: {
          ...options,
          name: key.name,
          scopes: key.scopes,
          audience: key.audience,
          permissionCeiling: key.permissions,
        },
        memberRole,
      });
      await options.recordAuditEvent(tx, {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY,
        resourceId: key.id,
        metadata: { reason: "rotated", replacementId: replacement.id },
      });
      return replacement;
    },
  );

export const updatePersonalApiKeyPolicy = async (
  options: MutationOptions & {
    policy: (typeof PERSONAL_API_KEY_POLICIES)[number];
  },
) =>
  mutatePersonalKeys(
    { ...options, authority: MANAGE },
    async ({ tx, memberRole }) => {
      if (
        !hasMemberPermission(memberRole, { organizationSettings: ["update"] })
      ) {
        return abortTransaction(
          new HandlerError({
            status: 403,
            message: "Organization administrator access required",
          }),
        );
      }
      if (options.policy === "disabled") {
        const revoked = await tx
          .update(apikey)
          .set({ enabled: false, updatedAt: new Date() })
          .where(
            and(
              personalScope(options.organizationId),
              eq(apikey.enabled, true),
            ),
          )
          .returning({ id: apikey.id, ownerUserId: apikey.referenceId });
        if (revoked.length > 0) {
          await options.recordAuditEvent(
            tx,
            revoked.map((key) => ({
              action: AUDIT_ACTION.DELETE,
              resourceType: AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY,
              resourceId: key.id,
              metadata: {
                reason: "policy_disabled",
                ownerUserId: key.ownerUserId,
              },
            })),
          );
        }
      }
      await tx
        .insert(organizationSettings)
        .values({
          id: createSafeId<"organizationSettings">(),
          organizationId: options.organizationId,
          personalApiKeyPolicy: options.policy,
        })
        .onConflictDoUpdate({
          target: organizationSettings.organizationId,
          set: {
            personalApiKeyPolicy: options.policy,
            updatedAt: new Date(),
          },
        });
      await options.recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
        resourceId: options.organizationId,
        metadata: { personalApiKeyPolicy: options.policy },
      });
      return { policy: options.policy };
    },
  );

type ListPersonalKeysOptions = Principal & {
  access: "own" | "organization";
  cursor?: string | undefined;
  limit: number;
};
export const listPersonalApiKeys = async (
  options: ListPersonalKeysOptions,
  database: Pick<typeof rootDb, "select"> = rootDb,
) => {
  const cursor =
    options.cursor === undefined
      ? null
      : machineApiKeyCursor.decode(options.cursor);
  if (
    options.cursor !== undefined &&
    cursor?.timestamp.precision !== "microseconds"
  ) {
    return abortTransaction(
      new HandlerError({ status: 400, message: "Invalid API key cursor" }),
    );
  }
  const rows = await database
    .select({
      ...machineApiKeyColumns,
      ownerName: user.name,
      createdAtCursor: machineApiKeyCursor.cursorValue.as("created_at_cursor"),
    })
    .from(apikey)
    .leftJoin(
      member,
      and(
        eq(member.userId, apikey.referenceId),
        eq(member.organizationId, options.organizationId),
      ),
    )
    .leftJoin(user, eq(user.id, member.userId))
    .where(
      and(
        personalScope(options.organizationId),
        options.access === "own"
          ? eq(apikey.referenceId, options.userId)
          : undefined,
        cursor === null
          ? undefined
          : machineApiKeyCursor.keysetAfter({
              cursor,
              idColumn: apikey.id,
              direction: "descending",
            }),
      ),
    )
    .orderBy(desc(apikey.createdAt), desc(apikey.id))
    .limit(options.limit + 1);
  const page = createCursorPage({
    rows,
    limit: options.limit,
    cursorForItem: (row) =>
      machineApiKeyCursor.encode(row.createdAtCursor, row.id),
  });
  return {
    ...page,
    policy: await readPersonalApiKeyPolicy(options.organizationId, database),
    options: {
      scopes: [...PERSONAL_API_KEY_SCOPES],
      audiences: [...PERSONAL_API_KEY_AUDIENCES],
      defaultScopes: [...PERSONAL_API_KEY_DEFAULT_SCOPES],
      defaultAudience: "default" as const,
      expiry: API_KEY_POLICY.personal,
      activeLimit: PERSONAL_API_KEY_ACTIVE_LIMIT,
      nameMaxLength: MACHINE_API_KEY_NAME_MAX_LENGTH,
    },
    items: page.items.flatMap((row) => {
      const summary = toMachineApiKeySummary(row);
      if (!summary || summary.kind !== API_KEY_KIND.personal) {
        return [];
      }
      return [
        {
          id: summary.id,
          name: summary.name,
          kind: summary.kind,
          ownerUserId: summary.ownerUserId,
          ownerName: row.ownerName,
          scopes: summary.scopes,
          audience: summary.audience,
          enabled: summary.enabled,
          start: row.start,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
          lastRequest: row.lastRequest,
        },
      ];
    }),
  };
};
