import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { createOpaqueOrganizationSlug } from "@stll/auth-model";
import { classifyFailure, declareFailureClass } from "@stll/errors";

import { member, organization, user } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import { organizationCreationRequests as receipts } from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import type { TransactionOf } from "@/api/db/scoped";
import { sharedPoolConnectionSettings } from "@/api/db/shared-pool-connection-settings";
import { createDatabase, createSqlClient } from "@/api/db/sql-client";
import { envBase } from "@/api/env-base";
import type { getAuth } from "@/api/lib/auth";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import type { SafeId } from "@/api/lib/branded-types";
import {
  instrumentSqlTransactionCounts,
  queryCountLogger,
} from "@/api/lib/db-query-counter";
import {
  lockMemberAccessRow,
  withAggregateLock,
  withAggregateSavepoint,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/db/audit-recording";
import type { AuditRecorder } from "@/api/lib/db/audit-recording";
import { runTransactionsInCallerContext } from "@/api/lib/db/caller-async-context";
import { recordLegalResolveAuditInTransaction } from "@/api/lib/db/legal-resolve-audit";
import type { LegalResolveAudit } from "@/api/lib/db/legal-resolve-audit";
import { meterSqlClient } from "@/api/lib/db/meter-client";
import { readAuditedActivitySummary } from "@/api/lib/db/operator-activity/read";
import type { RegistrationQuery } from "@/api/lib/db/operator-registrations/input";
import { readAuditedRegistrationPage } from "@/api/lib/db/operator-registrations/read";
import { createOrganizationWithEvaluation } from "@/api/lib/db/organization-creation";
import type { OrganizationEvaluation } from "@/api/lib/db/organization-creation";
import { runWithOrganizationSlugUpdate } from "@/api/lib/db/organization-slug-update-scope";
import { PARTNER_CLIENT_TYPE } from "@/api/lib/db/partner-client-contract";
import {
  changePartnerOAuthClientInTransaction,
  createPartnerOAuthClientInTransaction,
} from "@/api/lib/db/partner-client-operator";
import type {
  ChangePartnerOAuthClientOptions,
  CreatePartnerOAuthClientOptions,
} from "@/api/lib/db/partner-client-operator";
import type { createReviewAccountOrganizationStore } from "@/api/lib/db/review-account-organization-store";
import { instrumentRootPoolTransactions } from "@/api/lib/db/root-pool-reservation";
import { readRootPoolSnapshot } from "@/api/lib/db/root-pool-snapshot";
import { readOAuthClientBinding } from "@/api/lib/db/service-client-binding";
import {
  changeServiceOAuthClientInTransaction,
  createServiceOAuthClientInTransaction,
} from "@/api/lib/db/service-client-operator";
import type {
  ChangeServiceOAuthClientOptions,
  CreateServiceOAuthClientOptions,
} from "@/api/lib/db/service-client-operator";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { fingerprintRequest } from "@/api/lib/idempotency/request-receipts";
import { createSanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import { isMemberRole } from "@/api/lib/member-roles";
import { createRootPoolWindow } from "@/api/lib/observability/root-pool-window";
import {
  hasMemberPermission,
  withCurrentMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import type {
  authorizeSyntheticSession,
  readSyntheticSessionAuthority,
  SyntheticSessionAuthorityReader,
} from "@/api/lib/synthetic-principal/session-authority";
import type { createSyntheticSessionStore } from "@/api/lib/synthetic-principal/store";
import { isLocalDevOpen } from "@/api/runtime-mode";

// Per-request query counter feeds the `x-db-queries` response header for the
// N+1 e2e guard. Local/CI only: deployed environments pass no logger at all,
// keeping zero per-query overhead on the hot path. The logger itself is a
// no-op unless a request has activated a counter store, so background jobs
// and boot-time queries are unaffected even when it is wired in. Must match
// the header gate in index.ts.
const queryLogger = isLocalDevOpen() ? queryCountLogger : undefined;

// Optional pool recycling. Defaults remain disabled until the Bun SQL runtime
// retires only idle connections; values are seconds and apply to both pools.
const poolRecycling = {
  maxLifetime: envBase.DATABASE_POOL_MAX_LIFETIME_S,
  idleTimeout: envBase.DATABASE_POOL_IDLE_TIMEOUT_S,
} as const;

// A transaction runs in the async context of the request that opened it, so
// its statements count toward that request's query budget, not a neighbour's.
const rootPoolWindow = createRootPoolWindow();
const rootPoolSettings = sharedPoolConnectionSettings("root");
const nativeRootClient = createSqlClient({
  url: envBase.DATABASE_URL,
  max: envBase.DATABASE_ROOT_POOL_MAX,
  ...poolRecycling,
  ...rootPoolSettings,
  connection: {
    ...rootPoolSettings.connection,
    application_name: `stella-root-${Bun.randomUUIDv7()}`,
  },
});
const rootClient = instrumentRootPoolTransactions(
  meterSqlClient(nativeRootClient),
  rootPoolWindow,
);

export const readRootPoolReport = async () => {
  const result = await readRootPoolSnapshot(nativeRootClient);
  return rootPoolWindow.flush(
    envBase.DATABASE_ROOT_POOL_MAX,
    result.isOk()
      ? { status: "observed", ...result.value }
      : { status: "unavailable", size: null, inUse: null, idle: null },
  );
};
const rlsClient = runTransactionsInCallerContext(
  instrumentSqlTransactionCounts(
    createSqlClient({
      url: envBase.DATABASE_URL,
      max: envBase.DATABASE_RLS_POOL_MAX,
      ...poolRecycling,
      ...sharedPoolConnectionSettings("raw_rls"),
    }),
  ),
);

/**
 * Primary database handle connecting as postgres (table owner).
 * This pool must never run scoped RLS transactions; it is reserved
 * for internal infrastructure such as workspace resolution and
 * Better Auth.
 */
export const rootDb = createDatabase({
  client: rootClient,
  relations: databaseRelations,
  logger: queryLogger,
});

const rawRlsDb = createDatabase({
  client: rlsClient,
  relations: databaseRelations,
  logger: queryLogger,
});

/**
 * Dedicated pool for scoped RLS transactions.
 *
 * Keeping this separate from `rootDb` makes root queries structurally
 * isolated from transaction-local role changes, even if a driver
 * ever mishandles connection cleanup after `set_config('role', ...)`.
 * The export only exposes `transaction`, so callers cannot use this
 * pool for non-scoped root-style reads by accident.
 */
export const rlsDb = markRlsDatabase({
  transaction: async <TResult>(
    fn: (tx: TransactionOf<typeof rawRlsDb>) => Promise<TResult>,
  ): Promise<TResult> => await rawRlsDb.transaction(fn),
});

/**
 * The scoped-transaction connection with `before` run first in each
 * transaction, while it still runs as the owner and ahead of the scoped role
 * switch. The review organization reset takes its organization-row lock and
 * membership check here; callers receive a scoped database, never the pool.
 */
export const createFencedRlsDatabase = (
  before: (tx: Transaction) => Promise<void>,
) =>
  markRlsDatabase({
    transaction: async <TResult>(
      fn: (tx: TransactionOf<typeof rawRlsDb>) => Promise<TResult>,
    ): Promise<TResult> =>
      await rawRlsDb.transaction(async (tx) => {
        await before(tx);
        return await fn(tx);
      }),
  });

/** The connection owner supplies only a role-restricted sanctions reader. */
export const createPublicSanctionsReader = () =>
  createSanctionsPublicReadDb(rlsDb);

/** The operator handler receives a bounded audited page, never the owner handle. */
export const readOperatorRegistrationPage = async (query: RegistrationQuery) =>
  await readAuditedRegistrationPage(rootDb, query);

/**
 * Binds the review-account organization store to the owner connection; the
 * operator command receives the operations, never the owner handle. The
 * store is passed in rather than imported, so nothing it depends on (the API
 * environment, audit, seeds) joins this module's import graph.
 */
export const bindOwnerReviewAccountOrganizationStore = (
  createStore: typeof createReviewAccountOrganizationStore,
) => createStore(rootDb);

/** The dedicated-session route receives its bounded store, never the owner handle. */
export const bindOwnerSyntheticSessionStore = (
  createStore: typeof createSyntheticSessionStore,
) => createStore(rootDb);

/** Dedicated-session validation receives one bounded owner operation. */
export const bindOwnerSyntheticSessionAuthorityReader =
  (
    readAuthority: typeof readSyntheticSessionAuthority,
  ): SyntheticSessionAuthorityReader =>
  async (options) =>
    await readAuthority(rootDb, options);

/** Better Auth binds its session decision without exporting the owner handle. */
export const bindOwnerSyntheticSessionAuthorizer =
  (authorize: typeof authorizeSyntheticSession) =>
  async (current: Parameters<typeof authorizeSyntheticSession>[1]) =>
    await authorize(rootDb, current);

export type RootDatabase = typeof rootDb;
export type Transaction = TransactionOf<RootDatabase>;

/** The deployment operator receives only audited activity aggregates. */
export const readOperatorActivitySummary = async (now: number) =>
  await withAggregateTransaction(rootDb, async (tx) =>
    readAuditedActivitySummary(tx, now),
  );

/** Organization-bound OAuth operations never expose the owner connection. */
export const readServiceOAuthClientBinding = async (clientId: string) =>
  await readOAuthClientBinding(rootDb, clientId);
export const createServiceOAuthClient = async (
  options: CreateServiceOAuthClientOptions,
) =>
  await withAggregateTransaction(
    rootDb,
    async (tx) =>
      await createServiceOAuthClientInTransaction({ ...options, tx }),
  );
export const changeServiceOAuthClient = async (
  options: ChangeServiceOAuthClientOptions,
) =>
  await withAggregateTransaction(
    rootDb,
    async (tx) =>
      await changeServiceOAuthClientInTransaction({ ...options, tx }),
  );
/** Whether a client is an operator-registered partner client. */
export const isPartnerOAuthClient = async (clientId: string) =>
  (await readOAuthClientBinding(rootDb, clientId))?.type ===
  PARTNER_CLIENT_TYPE;
/** Partner clients are global (no organization); each user consents. */
export const createPartnerOAuthClient = async (
  options: CreatePartnerOAuthClientOptions,
) =>
  await withAggregateTransaction(
    rootDb,
    async (tx) =>
      await createPartnerOAuthClientInTransaction({ ...options, tx }),
  );
export const changePartnerOAuthClient = async (
  options: ChangePartnerOAuthClientOptions,
) =>
  await withAggregateTransaction(
    rootDb,
    async (tx) =>
      await changePartnerOAuthClientInTransaction({ ...options, tx }),
  );
export const recordLegalResolveAudit = async (options: LegalResolveAudit) =>
  await withAggregateTransaction(
    rootDb,
    async (tx) =>
      await recordLegalResolveAuditInTransaction({ ...options, tx }),
  );

// Migrated databases use PostgreSQL's inline UNIQUE name; schema-sync databases
// use Drizzle's name. Both also have the explicitly named unique index.
const SLUG_UNIQUE_CONSTRAINTS = [
  "organization_slug_key",
  "organization_slug_unique",
  "organization_slug_uidx",
] as const;

/** Better Auth and both schema origins report a taken organization slug. */
const isSlugConflict = (error: unknown) =>
  (error instanceof APIError &&
    (error.body?.code === "ORGANIZATION_ALREADY_EXISTS" ||
      error.body?.code === "ORGANIZATION_SLUG_ALREADY_TAKEN")) ||
  SLUG_UNIQUE_CONSTRAINTS.some((constraint) =>
    isPgConstraintError(error, PG_ERROR.UNIQUE_VIOLATION, constraint),
  );

const updatedOrganizationSchema = v.object({ slug: v.string() });
const slugConflict = () =>
  new HandlerError({
    status: 409,
    code: "organization_slug_conflict",
    message:
      "This organization slug is already taken. Choose another slug or use the opaque option.",
  });

type ChangeOrganizationSlugOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  slug: string;
  recordAuditEvent: AuditRecorder;
  auth: ReturnType<typeof getAuth>;
};

class OrganizationSlugUpdateError extends HandlerError<500> {
  override readonly name = "OrganizationSlugUpdateError";
  static {
    declareFailureClass(this, "tagged_failure");
  }
  constructor(cause: unknown) {
    super({
      status: 500,
      code: "organization_slug_update_failed",
      message: "Could not change the organization slug.",
      cause,
    });
  }
}

/** Auth tables deny application writes; the owner transaction binds the plugin write and audit. */
export const changeOrganizationSlug = async ({
  organizationId,
  userId,
  memberRole,
  slug,
  recordAuditEvent,
  auth,
}: ChangeOrganizationSlugOptions) =>
  await Result.tryPromise({
    try: async () =>
      await withAggregateTransaction(rootDb, async (tx) => {
        await withAggregateLock({
          tx,
          aggregate: "organization",
          id: organizationId,
          mode: "update",
        });
        const current = (
          await tx
            .select({ slug: organization.slug })
            .from(organization)
            .where(eq(organization.id, organizationId))
            .limit(1)
        ).at(0);
        const membership = await lockMemberAccessRow({
          tx,
          organizationId,
          userId,
          mode: "share",
        });
        if (
          !current ||
          !membership ||
          !isMemberRole(membership.role) ||
          !hasMemberPermission(
            withCurrentMemberRole(memberRole, membership.role),
            {
              organization: ["update"],
            },
          )
        ) {
          return abortTransaction(
            new HandlerError({
              status: 403,
              message:
                "Only organization owners and admins may change its slug.",
            }),
          );
        }
        const actor = (
          await tx
            .select({ user })
            .from(user)
            .innerJoin(
              member,
              and(
                eq(member.userId, user.id),
                eq(member.organizationId, organizationId),
              ),
            )
            .where(eq(user.id, userId))
            .limit(1)
        ).at(0);
        if (!actor) {
          return abortTransaction(
            new HandlerError({
              status: 401,
              message: "The account is no longer available.",
            }),
          );
        }
        // This server-only endpoint receives the already authenticated principal, not a
        // new credential. Its adapter stays inside the transaction; organization hooks run.
        const context = {
          ...(await auth.$context),
          adapter: drizzleAdapter(
            tx,
            AUTH_DATABASE_ADAPTER_OPTIONS,
          )(auth.options),
          getSession: async () =>
            await Promise.resolve({
              user: actor.user,
              session: { activeOrganizationId: organizationId },
            }),
        };
        const updated: unknown = await runWithOrganizationSlugUpdate(
          { organizationId, userId, slug },
          async () =>
            await auth.organizationUpdateEndpoint({
              headers: new Headers(),
              context,
              body: { organizationId, data: { slug } },
            }),
        );
        const result = v.parse(updatedOrganizationSchema, updated);
        if (current.slug !== result.slug) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: organizationId,
            changes: { slug: { old: current.slug, new: result.slug } },
          });
        }
        return result;
      }),
    catch: (cause: unknown) => {
      if (HandlerError.is(cause)) {
        return cause;
      }
      if (isSlugConflict(cause)) {
        return slugConflict();
      }
      return new OrganizationSlugUpdateError(cause);
    },
  });

const MAX_SLUG_ATTEMPTS = 20;

const createSlugConflict = () =>
  new HandlerError({
    status: 409,
    code: "organization_slug_conflict",
    message: "Organization slug is already in use.",
    hint: "Call organizations.create with a different slug, or omit slug to generate one.",
  });

export type CreateOrganizationOptions = {
  userId: SafeId<"user">;
  name: string;
  slug?: string;
  evaluation: OrganizationEvaluation;
  idempotencyKey: string | null;
};

export type OrganizationCreationDependencies = {
  fillRandom?: (bytes: Uint8Array) => void;
  database?: Pick<RootDatabase, "transaction">;
  createOrganization: (input: {
    transaction: Transaction;
    body: {
      name: string;
      slug: string;
      userId: SafeId<"user">;
      keepCurrentActiveOrganization: true;
    };
  }) => Promise<{ id: string; name: string; slug: string }>;
};

type OrganizationProviderDependencies = Required<
  Pick<OrganizationCreationDependencies, "createOrganization" | "fillRandom">
> & { transaction: Transaction };

const createWithAvailableSlug = async (
  {
    userId,
    name,
    slug,
  }: Pick<CreateOrganizationOptions, "userId" | "name" | "slug">,
  {
    createOrganization,
    fillRandom,
    transaction,
  }: OrganizationProviderDependencies,
) => {
  const created = await Result.tryPromise(
    {
      try: async () => {
        const candidate = slug ?? createOpaqueOrganizationSlug(fillRandom);
        return await withAggregateSavepoint(
          transaction,
          async (tx) =>
            await createOrganization({
              transaction: tx,
              body: {
                name,
                slug: candidate,
                userId,
                keepCurrentActiveOrganization: true,
              },
            }),
        );
      },
      catch: (cause) => cause,
    },
    {
      retry: {
        times: MAX_SLUG_ATTEMPTS - 1,
        delayMs: 0,
        backoff: "constant",
        shouldRetry: (cause) => slug === undefined && isSlugConflict(cause),
      },
    },
  );
  if (created.isOk()) {
    return created;
  }
  if (isSlugConflict(created.error)) {
    return Result.err(createSlugConflict());
  }
  if (created.error instanceof APIError && created.error.statusCode === 403) {
    return Result.err(
      new HandlerError({
        status: 403,
        code: "account_access_unavailable",
        message: "Organization creation is unavailable for this account.",
        hint: "Sign in with an unrestricted account.",
      }),
    );
  }
  return Result.err(
    classifyFailure(
      new HandlerError({
        status: 500,
        code: "internal_error",
        message: "Organization creation could not be completed.",
        cause: created.error,
      }),
      "tagged_failure",
    ),
  );
};

/** Organization, lifecycle defaults, evaluation claim, audit and receipt commit together. */
export const createOrganizationForAccount = async (
  { userId, name, slug, evaluation, idempotencyKey }: CreateOrganizationOptions,
  {
    database = rootDb,
    createOrganization,
    fillRandom = (bytes) => {
      crypto.getRandomValues(bytes);
    },
  }: OrganizationCreationDependencies,
) => {
  const fingerprint = fingerprintRequest({
    method: "POST",
    route: "organizations.create",
    body: { name, slug },
    params: {},
    query: {},
  });
  const key = idempotencyKey;
  if (key !== null && (key.length === 0 || key.length > 128)) {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "invalid_idempotency_key",
        message: "Idempotency-Key must contain 1 to 128 characters.",
      }),
    );
  }
  return await Result.tryPromise({
    try: async () =>
      await withAggregateTransaction(database, async (tx) => {
        if (key !== null) {
          const claimed = await tx
            .insert(receipts)
            .values({ userId, key, fingerprint })
            .onConflictDoNothing()
            .returning({ key: receipts.key });
          if (claimed.length === 0) {
            const receipt = (
              await tx
                .select()
                .from(receipts)
                .where(and(eq(receipts.userId, userId), eq(receipts.key, key)))
                .limit(1)
            ).at(0);
            if (receipt === undefined) {
              panic("Conflicting organization receipt disappeared");
            }
            if (receipt.fingerprint !== fingerprint) {
              return abortTransaction(
                new HandlerError({
                  status: 409,
                  code: "idempotency_key_reused",
                  message: "This key identifies a different creation request.",
                  hint: "Retry the original input, or use a new Idempotency-Key for a new organization.",
                }),
              );
            }
            if (
              receipt.organizationId !== null &&
              receipt.name !== null &&
              receipt.slug !== null
            ) {
              return {
                organizationId: receipt.organizationId,
                name: receipt.name,
                slug: receipt.slug,
                role: "owner" as const,
              };
            }
            return abortTransaction(
              new HandlerError({
                status: 409,
                code: "idempotency_in_progress",
                message: "Organization creation is still pending.",
                hint: "Retry with the same Idempotency-Key later. If it remains pending, contact support; do not create a second organization.",
              }),
            );
          }
        }
        const created = await createOrganizationWithEvaluation(
          tx,
          { userId, evaluation },
          async () => {
            const inserted = await createWithAvailableSlug(
              { userId, name, ...(slug === undefined ? {} : { slug }) },
              { createOrganization, fillRandom, transaction: tx },
            );
            if (inserted.isErr()) {
              return Result.err(inserted.error);
            }
            return Result.ok({
              organizationId: brandPersistedOrganizationId(inserted.value.id),
              name: inserted.value.name,
              slug: inserted.value.slug,
              role: "owner" as const,
            });
          },
        );
        if (created.isErr()) {
          return abortTransaction(created.error);
        }
        const result = created.value;
        if (key !== null) {
          await tx
            .update(receipts)
            .set({
              organizationId: result.organizationId,
              name: result.name,
              slug: result.slug,
            })
            .where(and(eq(receipts.userId, userId), eq(receipts.key, key)));
        }
        return result;
      }),
    catch: (cause) =>
      HandlerError.is(cause)
        ? cause
        : classifyFailure(
            new HandlerError({
              status: 500,
              code: "internal_error",
              message: "Organization creation could not be completed.",
              cause,
            }),
            "tagged_failure",
          ),
  });
};
