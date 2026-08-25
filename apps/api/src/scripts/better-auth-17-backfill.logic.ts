import { Result, TaggedError } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { isRecord } from "@/api/lib/type-guards";
import type {
  BetterAuthExpectedOAuthResource,
  BetterAuthTrustedIdentityMap,
} from "@/api/scripts/better-auth-migration-audit.logic";

const PROVIDER_ID = {
  CREDENTIAL: "credential",
  GOOGLE: "google",
  MICROSOFT: "microsoft",
} as const;

const ISSUER = {
  CREDENTIAL: "local:credential",
  GOOGLE: "https://accounts.google.com",
} as const;

const APPLICATION_TYPES = new Set(["native", "web"]);
const OAUTH_PROTOCOL_SCOPES = new Set([
  "email",
  "offline_access",
  "openid",
  "profile",
]);

export class BetterAuthBackfillError extends TaggedError(
  "BetterAuthBackfillError",
)<{
  cause?: unknown;
  code: "database-query-failed" | "invalid-source-state";
  message: string;
}> {}

export type BetterAuthBackfillDatabase = {
  transaction: <T>(
    callback: (transaction: BetterAuthBackfillTransaction) => Promise<T>,
  ) => Promise<T>;
};

export type BetterAuthBackfillTransaction = {
  execute: (statement: SQL) => Promise<unknown>;
};

type BetterAuthBackfillOptions = {
  batchSize: number;
  database: BetterAuthBackfillDatabase;
  expectedOAuthResources: readonly BetterAuthExpectedOAuthResource[];
  trustedIdentityMap: BetterAuthTrustedIdentityMap;
};

export type BetterAuthBackfillResult = {
  changed: boolean;
};

const queryRows = async (
  transaction: BetterAuthBackfillTransaction,
  statement: SQL,
) => {
  const queried = await Result.tryPromise({
    try: async () => await transaction.execute(statement),
    catch: (cause) =>
      new BetterAuthBackfillError({
        cause,
        code: "database-query-failed",
        message: "Better Auth backfill database query failed",
      }),
  });
  if (Result.isError(queried)) {
    return queried;
  }
  if (Array.isArray(queried.value)) {
    return Result.ok(queried.value);
  }
  if (isRecord(queried.value) && Array.isArray(queried.value["rows"])) {
    return Result.ok(queried.value["rows"]);
  }
  return Result.err(
    new BetterAuthBackfillError({
      code: "database-query-failed",
      message: "Better Auth backfill database returned an invalid result",
    }),
  );
};

const requiredString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const optionalStringArray = (value: unknown): readonly string[] | null => {
  if (value === null) {
    return [];
  }
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : null;
};

const nullableString = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
};

const invalidSourceState = () =>
  Result.err(
    new BetterAuthBackfillError({
      code: "invalid-source-state",
      message: "Better Auth backfill source state is not trusted",
    }),
  );

const runBackfillTransaction = async <T>(
  database: BetterAuthBackfillDatabase,
  operation: (
    transaction: BetterAuthBackfillTransaction,
  ) => Promise<Result<T, BetterAuthBackfillError>>,
): Promise<Result<T, BetterAuthBackfillError>> =>
  await Result.tryPromise({
    try: async () =>
      await database.transaction(async (transaction) => {
        const result = await operation(transaction);
        if (Result.isError(result)) {
          throw result.error;
        }
        return result.value;
      }),
    catch: (cause) =>
      cause instanceof BetterAuthBackfillError
        ? cause
        : new BetterAuthBackfillError({
            cause,
            code: "database-query-failed",
            message: "Better Auth backfill transaction failed",
          }),
  });

/**
 * Fence every table whose identity or OAuth policy this command mutates.
 * SHARE ROW EXCLUSIVE still permits reads, but conflicts with ordinary DML
 * and with another backfill. The private cutover also scales application
 * writers to zero; this lock makes a missed or delayed writer fail the short
 * lock timeout instead of racing a partially migrated identity.
 */
export const lockBetterAuth17BackfillTables = async (
  transaction: BetterAuthBackfillTransaction,
) =>
  await queryRows(
    transaction,
    sql`
      LOCK TABLE account,
                 oauth_client,
                 oauth_client_resource,
                 oauth_resource
        IN SHARE ROW EXCLUSIVE MODE
    `,
  );

const deterministicId = (type: "link" | "resource", values: string[]) => {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const value of values) {
    hasher.update(value);
    hasher.update("\0");
  }
  return `better-auth-${type}-${hasher.digest("hex")}`;
};

type AccountBackfillValue = {
  accountId: string;
  accountRowId: string;
  issuer: string;
};

const backfillAccountPage = async ({
  after,
  batchSize,
  microsoftByRowId,
  transaction,
}: {
  after: string | null;
  batchSize: number;
  microsoftByRowId: ReadonlyMap<
    string,
    BetterAuthTrustedIdentityMap["microsoftAccounts"][number]
  >;
  transaction: BetterAuthBackfillTransaction;
}) => {
  const selected = await queryRows(
    transaction,
    after === null
      ? sql`
          SELECT id AS "accountRowId",
                 account_id AS "accountId",
                 provider_id AS "providerId",
                 user_id AS "userId",
                 issuer
            FROM account
           ORDER BY id
           LIMIT ${batchSize}
           FOR UPDATE
        `
      : sql`
          SELECT id AS "accountRowId",
                 account_id AS "accountId",
                 provider_id AS "providerId",
                 user_id AS "userId",
                 issuer
            FROM account
           WHERE id > ${after}
           ORDER BY id
           LIMIT ${batchSize}
           FOR UPDATE
        `,
  );
  if (Result.isError(selected)) {
    return selected;
  }

  const updates: AccountBackfillValue[] = [];
  let nextAfter: string | null = after;
  for (const row of selected.value) {
    const accountRowId = isRecord(row)
      ? requiredString(row["accountRowId"])
      : null;
    const currentAccountId = isRecord(row)
      ? requiredString(row["accountId"])
      : null;
    const providerId = isRecord(row) ? requiredString(row["providerId"]) : null;
    const userId = isRecord(row) ? requiredString(row["userId"]) : null;
    const currentIssuer = isRecord(row)
      ? nullableString(row["issuer"])
      : undefined;
    if (
      accountRowId === null ||
      currentAccountId === null ||
      providerId === null ||
      userId === null ||
      currentIssuer === undefined
    ) {
      return invalidSourceState();
    }

    let accountId = currentAccountId;
    let issuer: string;
    switch (providerId) {
      case PROVIDER_ID.CREDENTIAL:
        if (currentAccountId !== userId) {
          return invalidSourceState();
        }
        issuer = ISSUER.CREDENTIAL;
        break;
      case PROVIDER_ID.GOOGLE:
        issuer = ISSUER.GOOGLE;
        break;
      case PROVIDER_ID.MICROSOFT: {
        const mapping = microsoftByRowId.get(accountRowId);
        if (
          mapping === undefined ||
          !(
            (currentAccountId === mapping.legacyAccountId &&
              currentIssuer === null) ||
            (currentAccountId === mapping.accountId &&
              currentIssuer === mapping.issuer)
          )
        ) {
          return invalidSourceState();
        }
        accountId = mapping.accountId;
        issuer = mapping.issuer;
        break;
      }
      default:
        return invalidSourceState();
    }
    updates.push({ accountId, accountRowId, issuer });
    nextAfter = accountRowId;
  }

  if (updates.length === 0) {
    return Result.ok({ changed: false, complete: true, nextAfter });
  }
  const updated = await queryRows(
    transaction,
    sql`
      WITH input AS (
        SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(updates)}::text::jsonb)
            AS row_value("accountId" text, "accountRowId" text, issuer text)
      )
      UPDATE account target
         SET account_id = input."accountId",
             issuer = input.issuer
        FROM input
       WHERE target.id = input."accountRowId"
         AND (target.account_id, target.issuer)
             IS DISTINCT FROM (input."accountId", input.issuer)
      RETURNING target.id
    `,
  );
  if (Result.isError(updated)) {
    return updated;
  }
  return Result.ok({
    changed: updated.value.length > 0,
    complete: selected.value.length < batchSize,
    nextAfter,
  });
};

const backfillAccounts = async (
  transaction: BetterAuthBackfillTransaction,
  batchSize: number,
  trustedIdentityMap: BetterAuthTrustedIdentityMap,
) => {
  const microsoftByRowId = new Map(
    trustedIdentityMap.microsoftAccounts.map((mapping) => [
      mapping.accountRowId,
      mapping,
    ]),
  );
  let after: string | null = null;
  let changed = false;
  const readNextPage = async (): Promise<
    Result<boolean, BetterAuthBackfillError>
  > => {
    const page = await backfillAccountPage({
      after,
      batchSize,
      microsoftByRowId,
      transaction,
    });
    if (Result.isError(page)) {
      return Result.err(page.error);
    }
    changed ||= page.value.changed;
    after = page.value.nextAfter;
    return page.value.complete ? Result.ok(changed) : readNextPage();
  };
  return readNextPage();
};

const seedOAuthResources = async (
  transaction: BetterAuthBackfillTransaction,
  expectedResources: readonly BetterAuthExpectedOAuthResource[],
) => {
  const seedResource = async (
    index: number,
    changed: boolean,
  ): Promise<Result<boolean, BetterAuthBackfillError>> => {
    const resource = expectedResources.at(index);
    if (resource === undefined) {
      return Result.ok(changed);
    }
    const existing = await queryRows(
      transaction,
      sql`
          SELECT name, allowed_scopes AS "allowedScopes"
            FROM oauth_resource
           WHERE identifier = ${resource.identifier}
           FOR UPDATE
        `,
    );
    if (Result.isError(existing)) {
      return existing;
    }
    const expectedScopes = [...resource.allowedScopes].toSorted();
    const row = existing.value.at(0);
    if (row !== undefined) {
      const name = isRecord(row) ? requiredString(row["name"]) : null;
      const allowedScopes = isRecord(row)
        ? optionalStringArray(row["allowedScopes"])
        : null;
      if (
        name !== resource.name ||
        allowedScopes === null ||
        JSON.stringify([...allowedScopes].toSorted()) !==
          JSON.stringify(expectedScopes)
      ) {
        return invalidSourceState();
      }
      return seedResource(index + 1, changed);
    }
    const inserted = await queryRows(
      transaction,
      sql`
          INSERT INTO oauth_resource (id, identifier, name, allowed_scopes)
          VALUES (
            ${deterministicId("resource", [resource.identifier])},
            ${resource.identifier},
            ${resource.name},
            ARRAY(
              SELECT jsonb_array_elements_text(
                ${JSON.stringify(expectedScopes)}::text::jsonb
              )
            )
          )
          RETURNING id
        `,
    );
    if (Result.isError(inserted)) {
      return inserted;
    }
    return seedResource(index + 1, true);
  };
  return seedResource(0, false);
};

type OAuthClientBackfillValue = {
  applicationType: string;
  clientCredentialsScopes: readonly string[];
  clientId: string;
};

const backfillOAuthClientPage = async ({
  after,
  batchSize,
  expectedResources,
  transaction,
}: {
  after: string | null;
  batchSize: number;
  expectedResources: readonly BetterAuthExpectedOAuthResource[];
  transaction: BetterAuthBackfillTransaction;
}) => {
  const selected = await queryRows(
    transaction,
    after === null
      ? sql`
            SELECT client_id AS "clientId",
                   type AS "applicationType",
                   scopes,
                   grant_types AS "grantTypes"
              FROM oauth_client
             ORDER BY client_id
             LIMIT ${batchSize}
             FOR UPDATE
          `
      : sql`
            SELECT client_id AS "clientId",
                   type AS "applicationType",
                   scopes,
                   grant_types AS "grantTypes"
              FROM oauth_client
             WHERE client_id > ${after}
             ORDER BY client_id
             LIMIT ${batchSize}
             FOR UPDATE
          `,
  );
  if (Result.isError(selected)) {
    return selected;
  }
  const clients: OAuthClientBackfillValue[] = [];
  let nextAfter = after;
  for (const row of selected.value) {
    const clientId = isRecord(row) ? requiredString(row["clientId"]) : null;
    const applicationType = isRecord(row)
      ? requiredString(row["applicationType"])
      : null;
    const scopes = isRecord(row) ? optionalStringArray(row["scopes"]) : null;
    const grantTypes = isRecord(row)
      ? optionalStringArray(row["grantTypes"])
      : null;
    if (
      clientId === null ||
      applicationType === null ||
      !APPLICATION_TYPES.has(applicationType) ||
      scopes === null ||
      grantTypes === null
    ) {
      return invalidSourceState();
    }
    clients.push({
      applicationType,
      clientCredentialsScopes: grantTypes.includes("client_credentials")
        ? [...new Set(scopes)]
            .filter((scope) => !OAUTH_PROTOCOL_SCOPES.has(scope))
            .toSorted()
        : [],
      clientId,
    });
    nextAfter = clientId;
  }
  if (clients.length === 0) {
    return Result.ok({ changed: false, complete: true, nextAfter });
  }

  const updated = await queryRows(
    transaction,
    sql`
        WITH input AS (
          SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(clients)}::text::jsonb)
              AS row_value(
                "applicationType" text,
                "clientCredentialsScopes" jsonb,
                "clientId" text
              )
        )
        UPDATE oauth_client target
           SET application_type = input."applicationType",
               client_credentials_scopes = ARRAY(
                 SELECT jsonb_array_elements_text(
                   input."clientCredentialsScopes"
                 )
               )
          FROM input
         WHERE target.client_id = input."clientId"
           AND (target.application_type, target.client_credentials_scopes)
               IS DISTINCT FROM (
                 input."applicationType",
                 ARRAY(
                   SELECT jsonb_array_elements_text(
                     input."clientCredentialsScopes"
                   )
                 )
               )
        RETURNING target.client_id
      `,
  );
  if (Result.isError(updated)) {
    return updated;
  }
  let changed = updated.value.length > 0;
  const links = clients.flatMap(({ clientId }) =>
    expectedResources.map(({ identifier }) => ({
      clientId,
      id: deterministicId("link", [clientId, identifier]),
      resourceId: identifier,
    })),
  );
  if (links.length > 0) {
    const inserted = await queryRows(
      transaction,
      sql`
          WITH input AS (
            SELECT *
              FROM jsonb_to_recordset(${JSON.stringify(links)}::text::jsonb)
                AS row_value("clientId" text, id text, "resourceId" text)
          )
          INSERT INTO oauth_client_resource (id, client_id, resource_id)
          SELECT id, "clientId", "resourceId"
            FROM input
          ON CONFLICT (client_id, resource_id) DO NOTHING
          RETURNING id
        `,
    );
    if (Result.isError(inserted)) {
      return inserted;
    }
    changed ||= inserted.value.length > 0;
  }
  return Result.ok({
    changed,
    complete: selected.value.length < batchSize,
    nextAfter,
  });
};

const backfillOAuthClients = async (
  transaction: BetterAuthBackfillTransaction,
  batchSize: number,
  expectedResources: readonly BetterAuthExpectedOAuthResource[],
) => {
  let after: string | null = null;
  let changed = false;
  const readNextPage = async (): Promise<
    Result<boolean, BetterAuthBackfillError>
  > => {
    const page = await backfillOAuthClientPage({
      after,
      batchSize,
      expectedResources,
      transaction,
    });
    if (Result.isError(page)) {
      return Result.err(page.error);
    }
    changed ||= page.value.changed;
    after = page.value.nextAfter;
    return page.value.complete ? Result.ok(changed) : readNextPage();
  };
  return readNextPage();
};

type BetterAuthBackfillTransactionOptions = Omit<
  BetterAuthBackfillOptions,
  "database"
> & {
  transaction: BetterAuthBackfillTransaction;
};

export const runBetterAuth17BackfillInTransaction = async ({
  batchSize,
  expectedOAuthResources,
  transaction,
  trustedIdentityMap,
}: BetterAuthBackfillTransactionOptions): Promise<
  Result<BetterAuthBackfillResult, BetterAuthBackfillError>
> => {
  const resources = await seedOAuthResources(
    transaction,
    expectedOAuthResources,
  );
  if (Result.isError(resources)) {
    return resources;
  }
  const accounts = await backfillAccounts(
    transaction,
    batchSize,
    trustedIdentityMap,
  );
  if (Result.isError(accounts)) {
    return accounts;
  }
  const clients = await backfillOAuthClients(
    transaction,
    batchSize,
    expectedOAuthResources,
  );
  if (Result.isError(clients)) {
    return clients;
  }
  return Result.ok({
    changed: resources.value || accounts.value || clients.value,
  });
};

export const runBetterAuth17Backfill = async ({
  batchSize,
  database,
  expectedOAuthResources,
  trustedIdentityMap,
}: BetterAuthBackfillOptions): Promise<
  Result<BetterAuthBackfillResult, BetterAuthBackfillError>
> => {
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000 ||
    expectedOAuthResources.length === 0
  ) {
    return invalidSourceState();
  }
  return await runBackfillTransaction(database, async (transaction) => {
    const locked = await lockBetterAuth17BackfillTables(transaction);
    if (Result.isError(locked)) {
      return Result.err(locked.error);
    }
    return await runBetterAuth17BackfillInTransaction({
      batchSize,
      expectedOAuthResources,
      transaction,
      trustedIdentityMap,
    });
  });
};
