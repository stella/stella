import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";
import type { SQL, SQLChunk } from "drizzle-orm";

import { mobileClientMetadataUrl } from "@stll/api-contract/mobile-client";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  oauthClient,
  oauthClientResource,
  oauthConsent,
  oauthResource,
} from "@/api/db/auth-schema";
import {
  assertBetterAuthOAuthPolicyCensus,
  ensureBetterAuthOAuthPolicy,
} from "@/api/lib/db/better-auth-oauth-policy-census";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";
import { MCP_LAW_HTTP_PATH } from "@/api/mcp/constants";
import {
  buildApiOAuthResource,
  buildEveryClientOAuthResources,
  isEveryClientOAuthResource,
  predecessorOAuthResourceScopes,
} from "@/api/mcp/resource-policy-contract";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import { BETTER_AUTH_OAUTH_RESOURCE_REPAIR } from "./better-auth-oauth-resource-repair";
import { ONLINE_MIGRATION_REPAIRS } from "./online-migrations";

/**
 * Adding an MCP audience widens `buildBetterAuthOAuthResources()`, and the
 * startup census refuses to serve until `oauth_resource` matches it. Startup
 * deliberately never repairs, so without an automated path the next release's
 * API would fail its boot gate on every environment until an operator ran the
 * one-time 1.7 cutover script under a write freeze.
 *
 * What replaces that is this online repair, which the migrate entrypoint runs
 * on every deploy before the API rolls. These drive it through the
 * `OnlineRepair` entry the migrator calls, over a connection shaped like the
 * one the online phase reserves, against the real configured resource set
 * rather than a fixture, so what runs here is the deploy's own code path.
 */

let database: TestDatabase;

const CLIENT_ID = "online-repair-client";

setDefaultTimeout(120_000);

beforeAll(async () => {
  database = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

/**
 * Rebuild a drizzle fragment from the parameterised query the repair emits. It
 * renders drizzle SQL to `(text, params)` for its raw connection; this reverses
 * that so the statement runs inside the test's transaction.
 */
const toDrizzleSql = (text: string, params: readonly unknown[]): SQL => {
  const chunks: SQLChunk[] = [];
  for (const [index, segment] of text.split(/\$(\d+)/gu).entries()) {
    if (index % 2 === 0) {
      chunks.push(sql.raw(segment));
      continue;
    }
    chunks.push(sql`${params[Number(segment) - 1]}`);
  }
  return sql.join(chunks);
};

const REPAIR_SAVEPOINT = "online_repair";

const translateTransactionControl = (query: string): string => {
  if (query === "BEGIN") {
    return `SAVEPOINT ${REPAIR_SAVEPOINT}`;
  }
  if (query === "COMMIT") {
    return `RELEASE SAVEPOINT ${REPAIR_SAVEPOINT}`;
  }
  if (query === "ROLLBACK") {
    return `ROLLBACK TO SAVEPOINT ${REPAIR_SAVEPOINT}`;
  }
  return query;
};

/**
 * The reserved-connection shape `online-migrations.ts` hands a repair.
 *
 * The repair owns its transaction and these tests own an outer one they roll
 * back, so its `BEGIN`/`COMMIT`/`ROLLBACK` are mapped onto a savepoint: the
 * repair keeps real atomicity and a failed run still leaves the session usable,
 * while the fixture stays rolled back. Nothing else is translated.
 */
const onlineConnection = (transaction: TestDatabaseTransaction) => {
  const run = async (query: string, params: readonly unknown[]) => {
    const result = await transaction.execute(
      toDrizzleSql(translateTransactionControl(query), params),
    );
    return result.rows;
  };
  return {
    execute: async (query: string, params: readonly unknown[] = []) => {
      await run(query, params);
    },
    query: async (query: string, params: readonly unknown[] = []) =>
      await run(query, params),
    release: () => undefined,
  };
};

/**
 * The resources a deployment served before the law audience and the REST API
 * resource were added.
 */
const preUpgradeResources = () =>
  getBetterAuthOAuthResources()
    .filter(
      (resource) =>
        isEveryClientOAuthResource(resource) &&
        !resource.identifier.endsWith(MCP_LAW_HTTP_PATH),
    )
    .map((resource) => ({
      ...resource,
      allowedScopes: predecessorOAuthResourceScopes(resource.allowedScopes),
    }));

const lawResourceIdentifier = (): string => {
  const law = getBetterAuthOAuthResources().find(({ identifier }) =>
    identifier.endsWith(MCP_LAW_HTTP_PATH),
  );
  if (law === undefined) {
    throw new Error("the law audience is not a configured OAuth resource");
  }
  return law.identifier;
};

const apiResourceIdentifier = (): string => {
  const api = getBetterAuthOAuthResources().find(
    (resource) => !isEveryClientOAuthResource(resource),
  );
  if (api === undefined) {
    throw new Error("the REST API is not a configured OAuth resource");
  }
  return api.identifier;
};

/** The pre-upgrade deployment: the resources it served, and a linked client. */
const givenPreUpgradeDeployment = async (
  transaction: TestDatabaseTransaction,
): Promise<void> => {
  await transaction.execute(sql`
    TRUNCATE "user", account, oauth_client_resource, oauth_resource,
             oauth_client CASCADE
  `);
  const resources = preUpgradeResources();
  await transaction.insert(oauthResource).values(
    resources.map((resource, index) => ({
      allowedScopes: [...resource.allowedScopes],
      id: `online-repair-resource-${index}`,
      identifier: resource.identifier,
      name: resource.name,
    })),
  );
  await transaction.insert(oauthClient).values({
    clientId: CLIENT_ID,
    id: "online-repair-client-row",
    redirectUris: ["https://client.example.invalid/callback"],
  });
  await transaction.insert(oauthClientResource).values(
    resources.map((resource, index) => ({
      clientId: CLIENT_ID,
      id: `online-repair-link-${index}`,
      resourceId: resource.identifier,
    })),
  );
};

const resourceIdentifiers = async (
  transaction: TestDatabaseTransaction,
): Promise<readonly unknown[]> =>
  (
    await transaction.execute(
      sql`SELECT identifier FROM oauth_resource ORDER BY identifier`,
    )
  ).rows;

const linkedResourceIds = async (
  transaction: TestDatabaseTransaction,
): Promise<readonly unknown[]> =>
  (
    await transaction.execute(sql`
      SELECT resource_id AS "resourceId"
        FROM oauth_client_resource
       WHERE client_id = ${CLIENT_ID}
       ORDER BY resource_id
    `)
  ).rows;

const resourcePolicies = async (transaction: TestDatabaseTransaction) =>
  (
    await transaction.execute(sql`
    SELECT identifier,
           ARRAY(SELECT unnest(allowed_scopes) ORDER BY 1) AS "allowedScopes",
           updated_at AS "updatedAt"
      FROM oauth_resource ORDER BY identifier
  `)
  ).rows;

test("the repair is registered, so every deploy reconciles the policy", () => {
  // The registry is what makes this automatic. A repair module nobody lists is
  // an operator script with extra steps, which is the defect being fixed.
  expect(ONLINE_MIGRATION_REPAIRS).toContain(BETTER_AUTH_OAUTH_RESOURCE_REPAIR);
  expect(BETTER_AUTH_OAUTH_RESOURCE_REPAIR.name).toBe(
    "better-auth-oauth-resources",
  );
});

test("the deploy repair adds a new audience to an existing database", async () => {
  try {
    await database.transaction(async (transaction) => {
      await givenPreUpgradeDeployment(transaction);
      const connection = onlineConnection(transaction);

      // The pre-upgrade database is consistent with the pre-upgrade code.
      await assertBetterAuthOAuthPolicyCensus(
        transaction,
        preUpgradeResources(),
      );

      // Booting the new image before the repair runs refuses to start, and
      // inserts nothing while refusing.
      expect(
        await rejectionOf(
          ensureBetterAuthOAuthPolicy(
            transaction,
            getBetterAuthOAuthResources(),
          ),
        ),
      ).toMatchObject({ failedChecks: ["resources-match"] });
      expect(await resourceIdentifiers(transaction)).not.toContainEqual({
        identifier: lawResourceIdentifier(),
      });

      // The deploy's repair, through the entry the migrator calls.
      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection);
      expect(
        await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.readCompletion(connection),
      ).toEqual({ type: "complete" });

      // The boot census the API runs now passes, so the API would serve.
      await ensureBetterAuthOAuthPolicy(
        transaction,
        getBetterAuthOAuthResources(),
      );
      expect(await resourceIdentifiers(transaction)).toContainEqual({
        identifier: lawResourceIdentifier(),
      });
      // Every row now issues with protocol scopes, so refresh keeps
      // offline_access.
      const policies = await resourcePolicies(transaction);
      for (const resource of getBetterAuthOAuthResources()) {
        expect(
          predecessorOAuthResourceScopes(resource.allowedScopes),
        ).not.toEqual(resource.allowedScopes);
        expect(policies).toContainEqual({
          identifier: resource.identifier,
          allowedScopes: resource.allowedScopes.toSorted(),
          updatedAt: expect.any(String),
        });
      }
      // And the registration that existed before the upgrade can request it,
      // but not the REST API, which only stella's own apps reach.
      expect(await linkedResourceIds(transaction)).toContainEqual({
        resourceId: lawResourceIdentifier(),
      });
      expect(await resourceIdentifiers(transaction)).toContainEqual({
        identifier: apiResourceIdentifier(),
      });
      expect(await linkedResourceIds(transaction)).not.toContainEqual({
        resourceId: apiResourceIdentifier(),
      });

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

test("a second repair run changes nothing", async () => {
  try {
    await database.transaction(async (transaction) => {
      await givenPreUpgradeDeployment(transaction);
      const connection = onlineConnection(transaction);

      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection);
      const resources = await resourceIdentifiers(transaction);
      const policies = await resourcePolicies(transaction);
      const links = await linkedResourceIds(transaction);

      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection);
      expect(
        await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.readCompletion(connection),
      ).toEqual({ type: "complete" });

      expect(await resourceIdentifiers(transaction)).toEqual(resources);
      expect(await resourcePolicies(transaction)).toEqual(policies);
      expect(await linkedResourceIds(transaction)).toEqual(links);

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

test("the API resource reaches stella's own app and no other client", async () => {
  // An https deployment, where the app has a metadata document client id.
  const origin = "https://stella-api.example.test";
  const mobileClientId = mobileClientMetadataUrl(origin) ?? "";
  const apiResource = buildApiOAuthResource(origin).identifier;
  const linksOf = async (
    transaction: TestDatabaseTransaction,
    clientId: string,
  ) =>
    (
      await transaction.execute(sql`
        SELECT resource_id AS "resourceId"
          FROM oauth_client_resource
         WHERE client_id = ${clientId}
         ORDER BY resource_id
      `)
    ).rows;
  try {
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        TRUNCATE "user", account, oauth_client_resource, oauth_resource,
                 oauth_client CASCADE
      `);
      const mcpResources = buildEveryClientOAuthResources(origin);
      await transaction.insert(oauthResource).values(
        mcpResources.map((resource, index) => ({
          allowedScopes: [...resource.allowedScopes],
          id: `own-app-resource-${index}`,
          identifier: resource.identifier,
          name: resource.name,
        })),
      );
      await transaction.insert(oauthClient).values([
        {
          clientId: CLIENT_ID,
          id: "own-app-third-party-row",
          redirectUris: ["https://client.example.invalid/callback"],
        },
        {
          clientId: mobileClientId,
          id: "own-app-mobile-row",
          redirectUris: ["app.stll:/oauth/callback"],
        },
      ]);
      await transaction.insert(oauthClientResource).values(
        [CLIENT_ID, mobileClientId].flatMap((clientId) =>
          mcpResources.map((resource) => ({
            clientId,
            id: `own-app-link-${clientId}-${resource.identifier}`,
            resourceId: resource.identifier,
          })),
        ),
      );
      const connection = onlineConnection(transaction);

      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection);
      expect(
        await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.readCompletion(connection),
      ).toEqual({ type: "complete" });

      expect(await linksOf(transaction, mobileClientId)).toContainEqual({
        resourceId: apiResource,
      });
      expect(await linksOf(transaction, CLIENT_ID)).not.toContainEqual({
        resourceId: apiResource,
      });

      const links = await linksOf(transaction, mobileClientId);
      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection);
      expect(await linksOf(transaction, mobileClientId)).toEqual(links);

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

const PROTOCOL_SCOPES = ["openid", "profile", "email", "offline_access"];

/**
 * The policy a released deployment actually held, frozen: the rows of the
 * release before the advanced audience existed, when external MCP access was
 * still part of the default audience and the resolve scope did not exist yet.
 * Later releases change the configured sets; the repair has to take a database
 * in this state to whatever the current code configures.
 */
const RELEASED_POLICY = [
  {
    allowedScopes: [
      "stella:search",
      "stella:read",
      "stella:templates",
      "stella:documents_write",
      "stella:matters_write",
      "stella:contacts_write",
      "stella:chat",
      "stella:knowledge_write",
      "stella:billing_write",
      "stella:admin_read",
      "stella:admin_write",
      "stella:onboarding",
      "stella:skills",
      "stella:external_mcps",
      "stella:feedback",
      ...PROTOCOL_SCOPES,
    ],
    name: "Stella MCP",
    path: "/mcp",
  },
  {
    allowedScopes: [
      "stella:search_anonymized",
      "stella:read_anonymized",
      "stella:templates_anonymized",
      ...PROTOCOL_SCOPES,
    ],
    name: "Stella MCP anonymized",
    path: "/mcp-anonymized",
  },
  {
    allowedScopes: [
      "stella:read",
      "stella:documents_write",
      "stella:matters_write",
      ...PROTOCOL_SCOPES,
    ],
    name: "Stella MCP documents",
    path: "/mcp-documents",
  },
  {
    allowedScopes: ["stella:search", "stella:read", ...PROTOCOL_SCOPES],
    name: "Stella MCP law",
    path: "/mcp-law",
  },
] as const;

const configuredResource = (path: string) => {
  const resource = getBetterAuthOAuthResources().find(
    ({ identifier }) => new URL(identifier).pathname === path,
  );
  if (resource === undefined) {
    throw new Error(`${path} is not a configured OAuth resource`);
  }
  return resource;
};

const releasedIdentifier = (path: string) =>
  new URL(path, configuredResource("/mcp").identifier).toString();

const MOVED_SCOPE = "stella:external_mcps";

const consentResources = async (transaction: TestDatabaseTransaction) =>
  (
    await transaction.execute(sql`
      SELECT id, resources FROM oauth_consent ORDER BY id
    `)
  ).rows;

const givenReleasedDeployment = async (
  transaction: TestDatabaseTransaction,
): Promise<void> => {
  await transaction.execute(sql`
    TRUNCATE "user", account, oauth_consent, oauth_client_resource,
             oauth_resource, oauth_client CASCADE
  `);
  await transaction.insert(oauthResource).values(
    RELEASED_POLICY.map((resource, index) => ({
      allowedScopes: [...resource.allowedScopes],
      id: `released-resource-${index}`,
      identifier: releasedIdentifier(resource.path),
      name: resource.name,
    })),
  );
  await transaction.insert(oauthClient).values({
    clientId: CLIENT_ID,
    id: "online-repair-client-row",
    redirectUris: ["https://client.example.invalid/callback"],
  });
  await transaction.insert(oauthClientResource).values(
    RELEASED_POLICY.map((resource, index) => ({
      clientId: CLIENT_ID,
      id: `released-link-${index}`,
      resourceId: releasedIdentifier(resource.path),
    })),
  );
  await transaction.insert(oauthConsent).values([
    {
      // Approved everything on the default audience, external MCPs included.
      clientId: CLIENT_ID,
      id: "consent-all",
      resources: [releasedIdentifier("/mcp")],
      scopes: ["openid", "stella:read", MOVED_SCOPE, "offline_access"],
    },
    {
      // Never approved the moved scope.
      clientId: CLIENT_ID,
      id: "consent-read",
      resources: [releasedIdentifier("/mcp")],
      scopes: ["openid", "stella:read", "offline_access"],
    },
    {
      // Holds the scope for a different audience only.
      clientId: CLIENT_ID,
      id: "consent-law",
      resources: [releasedIdentifier("/mcp-law")],
      scopes: ["openid", "stella:read", MOVED_SCOPE],
    },
  ]);
};

test("the deploy repair takes a released policy to the configured scopes", async () => {
  try {
    await database.transaction(async (transaction) => {
      await givenReleasedDeployment(transaction);
      const connection = onlineConnection(transaction);
      const advanced = configuredResource("/mcp/advanced");
      expect(advanced.allowedScopes).toContain(MOVED_SCOPE);
      expect(configuredResource("/mcp").allowedScopes).not.toContain(
        MOVED_SCOPE,
      );

      // The new image refuses to boot on the released policy.
      expect(
        await rejectionOf(
          ensureBetterAuthOAuthPolicy(
            transaction,
            getBetterAuthOAuthResources(),
          ),
        ),
      ).toMatchObject({ failedChecks: ["resources-match"] });

      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection);
      expect(
        await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.readCompletion(connection),
      ).toEqual({ type: "complete" });
      await ensureBetterAuthOAuthPolicy(
        transaction,
        getBetterAuthOAuthResources(),
      );

      // Every stored audience now carries exactly the configured scopes,
      // widened and narrowed alike, and the new audience exists and is linked.
      const policies = await resourcePolicies(transaction);
      for (const resource of getBetterAuthOAuthResources()) {
        expect(policies).toContainEqual({
          identifier: resource.identifier,
          allowedScopes: resource.allowedScopes.toSorted(),
          updatedAt: expect.any(String),
        });
      }
      expect(await linkedResourceIds(transaction)).toContainEqual({
        resourceId: advanced.identifier,
      });

      // A name an earlier release stored is carried to the configured name.
      const names = (
        await transaction.execute(sql`
          SELECT identifier, name FROM oauth_resource
        `)
      ).rows;
      for (const resource of getBetterAuthOAuthResources()) {
        expect(names).toContainEqual({
          identifier: resource.identifier,
          name: resource.name,
        });
      }

      // Whoever approved the moved scope keeps it where it now lives, without
      // being asked again; nobody else gains an audience.
      expect(await consentResources(transaction)).toEqual([
        {
          id: "consent-all",
          resources: [releasedIdentifier("/mcp"), advanced.identifier],
        },
        {
          id: "consent-law",
          resources: [releasedIdentifier("/mcp-law")],
        },
        {
          id: "consent-read",
          resources: [releasedIdentifier("/mcp")],
        },
      ]);

      // A second deploy finds nothing to change.
      const consents = await consentResources(transaction);
      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection);
      expect(await resourcePolicies(transaction)).toEqual(policies);
      expect(await consentResources(transaction)).toEqual(consents);

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

test.each(["name", "scopes", "disabled"] as const)(
  "the repair refuses a conflicting resource %s",
  async (conflict) => {
    try {
      await database.transaction(async (transaction) => {
        await givenPreUpgradeDeployment(transaction);
        const connection = onlineConnection(transaction);
        const existing = preUpgradeResources().at(-1);
        if (existing === undefined) {
          throw new Error("expected a pre-upgrade resource");
        }

        // A stored definition this code never configured (a foreign scope, a
        // renamed or disabled audience) is never overwritten: the repair
        // refuses, exactly as the cutover command does.
        const conflicts = {
          name: sql`UPDATE oauth_resource SET name = 'conflicting resource name' WHERE identifier = ${existing.identifier}`,
          scopes: sql`UPDATE oauth_resource SET allowed_scopes = ARRAY['unexpected:scope'] WHERE identifier = ${existing.identifier}`,
          disabled: sql`UPDATE oauth_resource SET disabled = true WHERE identifier = ${existing.identifier}`,
        };
        await transaction.execute(conflicts[conflict]);
        const before = (
          await transaction.execute(sql`
        SELECT name, allowed_scopes, disabled FROM oauth_resource
         WHERE identifier = ${existing.identifier}
      `)
        ).rows;
        const policiesBefore = await resourcePolicies(transaction);

        expect(
          await rejectionOf(
            BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection),
          ),
        ).toMatchObject({ code: "invalid-source-state" });
        expect(
          (
            await transaction.execute(sql`
            SELECT name, allowed_scopes, disabled FROM oauth_resource
             WHERE identifier = ${existing.identifier}
          `)
          ).rows,
        ).toEqual(before);
        // Earlier resources were upgraded before this conflict was detected.
        // A rejected repair must roll back those changes too.
        expect(await resourcePolicies(transaction)).toEqual(policiesBefore);
        // Refusing leaves the deploy to fail on the completion read rather than
        // on a half-written policy.
        expect(
          await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.readCompletion(connection),
        ).toMatchObject({ type: "incomplete" });

        transaction.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) {
        throw error;
      }
    }
  },
);
