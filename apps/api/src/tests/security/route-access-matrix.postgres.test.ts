import { panic } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import path from "node:path";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { ACTORS } from "../../../scripts/lib/route-access-matrix";
import type {
  AccessMatrixActor,
  AccessMatrixActorId,
} from "../../../scripts/lib/route-access-matrix";
import {
  readRouteAccessChangedSources,
  selectAffectedRouteAccessFixtures,
} from "../../../scripts/lib/route-access-selection";
import { member, organization, user } from "../../db/auth-schema";
import {
  caseLawDecisions,
  chatThreads,
  legislationDocuments,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  userFiles,
  userProfessionalUseAcceptances,
} from "../../db/schema";
import { env } from "../../env";
import readUserFileContent from "../../handlers/user-files/read-content";
import { getAuth } from "../../lib/auth";
import { createSafeId } from "../../lib/branded-types";
import type { SafeId } from "../../lib/branded-types";
import { createRouteRegistryMatcher } from "../../lib/route-registry-matcher";
import { parseAuthProviderId } from "../../lib/safe-id-boundaries";
import {
  FREE_TIER_OFF,
  resolveOrganizationAccess,
} from "../../lib/usage/organization-access";
import { readOrganizationAccessSnapshot } from "../../lib/usage/organization-access-snapshot";
import { setRuntimeModeForTesting } from "../../runtime-mode";
import { openGatedTestDatabase } from "../gated-test-database";
import type { GatedTestDb } from "../gated-test-database";
import { mintAuthProviderIdValue } from "../helpers/auth-provider-id";
import { testFileKey } from "../helpers/file-key";
import { createHumanSession, signInHuman } from "../helpers/human-session";
import type { HumanBrowser } from "../helpers/human-session";
import { createTestState } from "../helpers/test-state";
import {
  cleanUpSearchCensus,
  newSearchCensusIds,
  seedSearchCensus,
} from "./public-law-search-census";
import {
  ACCESS_MATRIX_DECISION_TEXT,
  ACCESS_MATRIX_STATUTE_TEXT,
  DOCUMENT_READ_PERMISSIONS,
  ROUTE_ACCESS_FIXTURES,
} from "./route-access-fixtures";
import type {
  RouteAccessFixture,
  RouteAccessFixtureContext,
} from "./route-access-fixtures";

const root = path.resolve(import.meta.dir, "../../../../..");
const selected = selectAffectedRouteAccessFixtures(ROUTE_ACCESS_FIXTURES, {
  root,
  changed: readRouteAccessChangedSources(root),
});
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];
const testState = createTestState({ file: import.meta.path, config: env });

type SignedActorDefinition = Exclude<AccessMatrixActor, { type: "anonymous" }>;
type SignedActor = {
  definition: SignedActorDefinition;
  browser: HumanBrowser;
  organizationId: SafeId<"organization">;
  userId: string;
  acceptedAt: Date;
  document: RouteAccessFixtureContext["document"];
};

type SeedActorOptions = {
  definition: SignedActorDefinition;
  database: GatedTestDb;
  owning: Awaited<ReturnType<typeof createHumanSession>>;
  actors: Map<AccessMatrixActorId, SignedActor>;
};

const seedActor = async ({
  definition,
  database,
  owning,
  actors,
}: SeedActorOptions) => {
  const email = `access-${definition.actor}-${Bun.randomUUIDv7()}@example.invalid`;
  const identity = await (async () => {
    if (definition.actor === "owner") {
      return owning;
    }
    if (definition.type === "owning-organization-role") {
      const browser = await signInHuman(email);
      await database.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId: owning.organizationId,
        userId: browser.userId,
        role: definition.role,
        createdAt: new Date(),
      });
      await browser.setActiveOrganization(owning.organizationId);
      return {
        browser,
        userId: browser.userId,
        organizationId: owning.organizationId,
      };
    }
    return await createHumanSession({
      email,
      orgName: "Access matrix fixture",
      orgSlugPrefix: "access-matrix",
    });
  })();
  const acceptedAt = new Date(Date.now() - (actors.size + 1) * 60_000);
  const document = {
    id: createSafeId<"userFile">(),
    s3Key: testFileKey(`user-files/access-matrix-${Bun.randomUUIDv7()}.txt`),
  };
  const organizationId =
    parseAuthProviderId<"organization">(identity.organizationId) ??
    panic("Auth returned an invalid organization identifier");
  actors.set(definition.actor, {
    definition,
    browser: identity.browser,
    userId: identity.userId,
    organizationId,
    acceptedAt,
    document,
  });
  await database
    .update(member)
    .set({ role: definition.role })
    .where(
      and(
        eq(member.userId, identity.userId),
        eq(member.organizationId, identity.organizationId),
      ),
    );
  await database
    .update(userProfessionalUseAcceptances)
    .set({ acceptedAt })
    .where(eq(userProfessionalUseAcceptances.userId, identity.userId));
  const now = new Date();
  const standing =
    definition.type === "organization-standing"
      ? definition.standing
      : "evaluation";
  const accessState =
    standing === "unpaid"
      ? {
          state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
          evaluationStartedAt: null,
          evaluationEndsAt: null,
          evaluationEndedAt: null,
        }
      : {
          state:
            standing === "expired"
              ? ORGANIZATION_ACCESS_STATE.evaluationEnded
              : ORGANIZATION_ACCESS_STATE.evaluationPeriod,
          evaluationStartedAt: new Date(now.getTime() - 86_400_000),
          evaluationEndsAt: new Date(
            now.getTime() + (standing === "expired" ? -60_000 : 86_400_000),
          ),
          evaluationEndedAt: standing === "expired" ? now : null,
        };
  await database
    .insert(organizationAccessStates)
    .values({
      organizationId,
      ...accessState,
    })
    .onConflictDoUpdate({
      target: organizationAccessStates.organizationId,
      set: accessState,
    });
  const threadId = createSafeId<"chatThread">();
  await database.insert(chatThreads).values({
    id: threadId,
    organizationId,
    userId: identity.userId,
    title: "Access matrix fixture",
    workspaceId: null,
  });
  await database.insert(userFiles).values({
    id: document.id,
    userId: identity.userId,
    threadId,
    s3Key: document.s3Key,
    fileName: "fixture.txt",
    mimeType: "text/plain",
    sizeBytes: 7,
    sha256Hex: "0".repeat(64),
  });
};

const assertActor = async (database: GatedTestDb, actor: SignedActor) => {
  const session = await getAuth().api.getSession({
    headers: actor.browser.headers(),
  });
  expect(session?.user.id).toBe(actor.userId);
  expect(session?.session.activeOrganizationId).toBe(actor.organizationId);
  const [facts] = await database
    .select({
      role: member.role,
      state: organizationAccessStates.state,
      endsAt: organizationAccessStates.evaluationEndsAt,
      acceptedAt: userProfessionalUseAcceptances.acceptedAt,
    })
    .from(member)
    .innerJoin(
      organizationAccessStates,
      eq(organizationAccessStates.organizationId, member.organizationId),
    )
    .innerJoin(
      userProfessionalUseAcceptances,
      eq(userProfessionalUseAcceptances.userId, member.userId),
    )
    .where(
      and(
        eq(member.userId, actor.userId),
        eq(member.organizationId, actor.organizationId),
      ),
    );
  expect(facts?.role).toBe(actor.definition.role);
  expect(facts?.acceptedAt.toISOString()).toBe(actor.acceptedAt.toISOString());
  const access = resolveOrganizationAccess({
    snapshot: await readOrganizationAccessSnapshot(
      database,
      actor.organizationId,
    ),
    now: new Date(),
    freeTier: FREE_TIER_OFF,
  });
  switch (actor.definition.type) {
    case "organization-standing":
      switch (actor.definition.standing) {
        case "unpaid":
          expect(access.type).toBe("self_managed_keys");
          expect(facts?.state).toBe(ORGANIZATION_ACCESS_STATE.selfManagedKeys);
          expect(facts?.endsAt).toBeNull();
          break;
        case "expired":
          expect(access.type).toBe("ended");
          expect(facts?.state).toBe(ORGANIZATION_ACCESS_STATE.evaluationEnded);
          expect(facts?.endsAt?.getTime()).toBeLessThan(Date.now());
          break;
        default:
          actor.definition.standing satisfies never;
          panic("Unhandled route access standing");
      }
      break;
    case "foreign-organization":
    case "owning-organization-role":
      expect(access.type).toBe("evaluation");
      expect(facts?.state).toBe(ORGANIZATION_ACCESS_STATE.evaluationPeriod);
      expect(facts?.endsAt?.getTime()).toBeGreaterThan(Date.now());
      break;
    default:
      actor.definition satisfies never;
      panic("Unhandled signed-in route access actor");
  }
  const [personalFile] = await database
    .select({
      workspaceId: chatThreads.workspaceId,
      organizationId: chatThreads.organizationId,
      userId: userFiles.userId,
      s3Key: userFiles.s3Key,
    })
    .from(userFiles)
    .innerJoin(chatThreads, eq(chatThreads.id, userFiles.threadId))
    .where(eq(userFiles.id, actor.document.id));
  expect(personalFile).toEqual({
    workspaceId: null,
    organizationId: actor.organizationId,
    userId: actor.userId,
    s3Key: actor.document.s3Key,
  });
};

describe.skipIf(!runPostgres || selected.length === 0)(
  "declared route access matrix on Postgres",
  () => {
    if (!runPostgres || selected.length === 0) {
      return;
    }
    if (databaseUrl === undefined) {
      panic("Route access matrix requires DATABASE_URL");
    }
    setDefaultTimeout(120_000);
    const { db: database, cleanUp } = openGatedTestDatabase(databaseUrl);
    const corpus = newSearchCensusIds();
    const actors = new Map<AccessMatrixActorId, SignedActor>();
    let handleRequest: (request: Request) => Response | Promise<Response>;
    let matchRoute: ReturnType<typeof createRouteRegistryMatcher>;
    let restoreRuntime: (() => void) | undefined;
    cleanUp(async () => {
      try {
        await cleanUpSearchCensus(database, corpus);
        if (actors.size !== 0) {
          await database.delete(organization).where(
            inArray(
              organization.id,
              [...actors.values()].map(({ organizationId }) => organizationId),
            ),
          );
          await database.delete(user).where(
            inArray(
              user.id,
              [...actors.values()].map(({ userId }) => userId),
            ),
          );
        }
      } finally {
        restoreRuntime?.();
      }
    });
    testState.beforeAll(async () => {
      for (const fixture of selected) {
        expect(fixture.cells.map(({ actor }) => actor).toSorted()).toEqual(
          ACTORS.map(({ actor }) => actor).toSorted(),
        );
      }
      testState.setConfig("E2E_DISABLE_AUTH_RATE_LIMIT", true);
      const owning = await createHumanSession({
        email: `access-owner-${Bun.randomUUIDv7()}@example.invalid`,
        orgName: "Access matrix owning fixture",
        orgSlugPrefix: "access-owning",
      });
      for (const definition of ACTORS) {
        if (definition.type !== "anonymous") {
          await seedActor({ definition, database, owning, actors });
        }
      }
      expect([...actors.keys()].toSorted()).toEqual(
        ACTORS.filter(({ type }) => type !== "anonymous")
          .map(({ actor }) => actor)
          .toSorted(),
      );
      const owner = actors.get("owner") ?? panic("Missing owning actor");
      const foreign =
        actors.get("foreign-organization") ?? panic("Missing foreign actor");
      expect(foreign.organizationId).not.toBe(owner.organizationId);
      await seedSearchCensus(database, corpus);
      await database
        .update(caseLawDecisions)
        .set({ fulltext: ACCESS_MATRIX_DECISION_TEXT })
        .where(eq(caseLawDecisions.id, corpus.decisionId));
      await database
        .update(legislationDocuments)
        .set({ fulltext: ACCESS_MATRIX_STATUTE_TEXT })
        .where(eq(legislationDocuments.id, corpus.documentId));
      expect(readUserFileContent.config.permissions).toEqual(
        DOCUMENT_READ_PERMISSIONS,
      );
      testState.setConfig("FEATURE_PUBLIC_LAW", true);
      testState.setConfig("FEATURE_ORG_ACCESS_STATE", true);
      testState.setConfig("FEATURE_FREE_TIER", false);
      testState.setConfig("FEATURE_CONFIGURED_ACCESS", false);
      testState.setConfig("E2E_DISABLE_AUTH_RATE_LIMIT", false);
      restoreRuntime = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
      const { default: api } = await import("../../server");
      handleRequest = api.handle.bind(api);
      matchRoute = createRouteRegistryMatcher({
        routes: api.routes,
        staticRoutes: api.router.static,
        strictPath: api.config.strictPath,
        aot: api.config.aot,
      });
    });

    const runCell =
      (
        fixture: RouteAccessFixture,
        cell: RouteAccessFixture["cells"][number],
      ) =>
      async () => {
        const owner = actors.get("owner") ?? panic("Missing owning actor");
        const actor = actors.get(cell.actor);
        if (cell.actor === "anonymous") {
          expect(actor).toBeUndefined();
          expect(
            await getAuth().api.getSession({ headers: new Headers() }),
          ).toBeNull();
        } else {
          if (actor === undefined) {
            panic(`Missing seeded actor ${cell.actor}`);
          }
          await assertActor(database, actor);
        }
        const context = {
          corpus,
          document:
            cell.actor === "foreign-organization"
              ? owner.document
              : (actor ?? owner).document,
          acceptedAt: (actor ?? owner).acceptedAt,
        };
        const request = fixture.request(
          context,
          actor?.browser.headers() ?? new Headers(),
        );
        const registered = matchRoute(request);
        expect(registered && `${registered.method} ${registered.path}`).toBe(
          fixture.id,
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(
          cell.expected === "allow" ? fixture.successStatus : cell.expected,
        );
        if (cell.expected !== "allow") {
          return;
        }
        const expected = fixture.expectedPayload(context);
        switch (expected.type) {
          case "object":
            expect(await response.json()).toMatchObject(expected.value);
            break;
          case "items":
            expect(await response.json()).toMatchObject({
              items: expected.values,
            });
            break;
          case "redirect": {
            const location =
              response.headers.get("location") ??
              panic("Download response has no location");
            expect(decodeURIComponent(new URL(location).pathname)).toContain(
              `/${expected.objectKey}`,
            );
            break;
          }
          default:
            expected satisfies never;
            panic("Unhandled route access payload expectation");
        }
      };
    for (const fixture of selected) {
      for (const cell of fixture.cells) {
        test(
          `${fixture.id}: ${cell.actor} receives its declared outcome`,
          runCell(fixture, cell),
        );
      }
    }
  },
);
