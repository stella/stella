import { defaultKeyHasher } from "@better-auth/api-key";
import { generateRandomString } from "better-auth/crypto";
import { Result } from "better-result";
import { and, desc, eq, gt } from "drizzle-orm";

import { apikey, member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import { organizationSettings } from "@/api/db/schema";
import {
  mintMachineApiKey,
  toMachineApiKeySummary,
} from "@/api/handlers/api-keys/mint";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  API_KEY_KIND,
  API_KEY_POLICY,
  PERSONAL_API_KEY_SCOPES,
  PERSONAL_API_KEY_AUDIENCES,
  MACHINE_API_KEY_LENGTH,
  MACHINE_API_KEY_NAME_MAX_LENGTH,
  MACHINE_API_KEY_PREFIX,
  MACHINE_API_KEY_RATE_LIMIT,
  MACHINE_API_KEY_START_LENGTH,
  PERSONAL_API_KEY_ACTIVE_LIMIT,
  PERSONAL_API_KEY_DEFAULT_SCOPES,
} from "@/api/lib/machine-api-key-config";
import type {
  PersonalApiKeyScope,
  PERSONAL_API_KEY_POLICIES,
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
type MutationOptions = Principal & {
  recordAuditEvent: AuditRecorder;
  database?: Pick<typeof rootDb, "transaction" | "select">;
};

// The auth table denies scoped-role access. These owner-level operations always
// retain the organization and owner predicates; the role is rechecked under lock.
const mutatePersonalKeys = async <T>(
  options: MutationOptions,
  run: (context: {
    tx: Transaction;
    memberRole: AuthorizedMemberRole;
  }) => Promise<T>,
) =>
  Result.tryPromise({
    try: async () =>
      (options.database ?? rootDb).transaction(async (tx) => {
        // All mint/rotate/policy changes take this lock first. The active limit and
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
        return run({ tx, memberRole: sessionMemberRole(membership.role) });
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
  tx: Transaction,
  { options, memberRole }: MintPersonalKeyInTransactionOptions,
) => {
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
    async ({ body }) => {
      // Use the plugin's generator/hasher contract, while keeping insertion and
      // its audit receipt in the same transaction as the active-key reservation.
      const key = `${MACHINE_API_KEY_PREFIX}${generateRandomString(MACHINE_API_KEY_LENGTH, "a-z", "A-Z")}`;
      const id = Bun.randomUUIDv7();
      const start = key.slice(0, MACHINE_API_KEY_START_LENGTH);
      const expiresAt = new Date(now.getTime() + body.expiresIn * 1000);
      await tx.insert(apikey).values({
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
      await options.recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY,
        resourceId: id,
        metadata: {
          name: body.name,
          scopes: body.metadata.scopes,
          audience: body.metadata.audience,
        },
      });
      return { id, start, key, expiresAt };
    },
  );
  if (minted.isErr()) {
    return abortTransaction(minted.error);
  }
  const summary = minted.value;
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
  mutatePersonalKeys(options, async ({ tx, memberRole }) =>
    mintPersonalKey(tx, { options, memberRole }),
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
  mutatePersonalKeys(options, async ({ tx, memberRole }) => {
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
  });

export const rotatePersonalApiKey = async (
  options: KeyOptions & { expiresInDays?: number | undefined },
) =>
  mutatePersonalKeys(options, async ({ tx, memberRole }) => {
    const key = await loadPersonalKey(tx, { ...options, access: "own" });
    if (!key.enabled || key.expiresAt === null || key.expiresAt <= new Date()) {
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
      .where(and(personalScope(options.organizationId), eq(apikey.id, key.id)));
    const replacement = await mintPersonalKey(tx, {
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
  });

export const updatePersonalApiKeyPolicy = async (
  options: MutationOptions & {
    policy: (typeof PERSONAL_API_KEY_POLICIES)[number];
  },
) =>
  mutatePersonalKeys(options, async ({ tx, memberRole }) => {
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
          and(personalScope(options.organizationId), eq(apikey.enabled, true)),
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
  });

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
