import { panic } from "better-result";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";
import {
  PROFESSIONAL_USE_STATEMENT_VERSION,
  PROFESSIONAL_USE_STATUS,
  PROFESSIONAL_USE_TERMS_VERSION,
} from "@stll/api-contract/professional-use";
import { roles } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { ACTORS } from "../../../scripts/lib/route-access-matrix";
import type {
  AccessMatrixActorId,
  AccessSubject,
  ExpectedAccessOutcome,
} from "../../../scripts/lib/route-access-matrix";
import type { SafeId } from "../../lib/branded-types";
import type { FileKey } from "../../lib/file-key";
import type { PublicRouteId } from "../../public-corpus-route-ids";
import type { SearchCensusIds } from "./public-law-search-census";

export const ROUTE_ACCESS_MATRIX_TEST_PATH =
  "apps/api/src/tests/security/route-access-matrix.postgres.test.ts";
export const ACCESS_MATRIX_DECISION_TEXT = "Public decision access fixture.";
export const ACCESS_MATRIX_STATUTE_TEXT = "Public statute access fixture.";
export const DOCUMENT_READ_PERMISSIONS = {
  chat: ["create"],
} satisfies PermissionInput;

export type RouteAccessFixtureContext = {
  corpus: SearchCensusIds;
  document: { id: SafeId<"userFile">; s3Key: FileKey };
  acceptedAt: Date;
};

type PayloadExpectation =
  | { type: "object"; value: Record<string, unknown> }
  | { type: "items"; values: readonly Record<string, unknown>[] }
  | { type: "redirect"; objectKey: string };

export type RouteAccessFixture = {
  id: string;
  subject: AccessSubject;
  testPath: string;
  sources: readonly string[];
  sharedSources: readonly string[];
  cells: readonly {
    actor: AccessMatrixActorId;
    expected: ExpectedAccessOutcome;
  }[];
  successStatus: 200 | 302;
  request: (context: RouteAccessFixtureContext, headers: Headers) => Request;
  expectedPayload: (context: RouteAccessFixtureContext) => PayloadExpectation;
};

type VersionedPublicRouteId = PublicRouteId extends infer Id
  ? Id extends `${infer Method} ${infer Path}`
    ? `${Method} ${typeof STELLA_API_VERSION_PREFIX}${Path}`
    : never
  : never;

const sharedSources = [
  "apps/api/src/server.ts",
  "apps/api/src/lib/api-handlers.ts",
  "apps/api/src/lib/auth.ts",
  "apps/api/src/lib/permission-authorization.ts",
  "packages/permissions/src/index.ts",
  "packages/auth-model/src/contract.ts",
  "apps/api/src/tests/helpers/human-session.ts",
  "apps/api/scripts/lib/route-access-matrix.ts",
  "apps/api/scripts/lib/route-access-selection.ts",
  "apps/api/src/tests/security/route-access-fixtures.ts",
  ROUTE_ACCESS_MATRIX_TEST_PATH,
];
const publicSources = [
  "apps/api/src/public-corpus-policy.ts",
  "apps/api/src/lib/public-law-read-db.ts",
  "apps/api/src/tests/security/public-law-search-census.ts",
];
const publicCells = ACTORS.map(({ actor }) => ({
  actor,
  expected: "allow" as const,
}));
const request = (path: string, headers: Headers) =>
  new Request(`http://localhost${STELLA_API_VERSION_PREFIX}${path}`, {
    headers,
  });

const publicFixtures = [
  {
    id: "GET /v1/case/decisions/:decisionId",
    sources: [
      "apps/api/src/handlers/case-law/public-routes.ts",
      "apps/api/src/handlers/case-law/decisions/get.ts",
    ],
    request: ({ corpus }, headers) =>
      request(`/case/decisions/${corpus.decisionId}`, headers),
    expectedPayload: ({ corpus }) => ({
      type: "object",
      value: {
        id: corpus.decisionId,
        caseNumber: "search-census",
        fulltext: ACCESS_MATRIX_DECISION_TEXT,
      },
    }),
  },
  {
    id: "GET /v1/case/decisions",
    sources: [
      "apps/api/src/handlers/case-law/public-routes.ts",
      "apps/api/src/handlers/case-law/decisions/list.ts",
    ],
    request: ({ corpus }, headers) =>
      request(
        `/case/decisions?country=CZE&sourceId=${corpus.caseLawSourceId}`,
        headers,
      ),
    expectedPayload: ({ corpus }) => ({
      type: "items",
      values: [
        { id: corpus.citingDecisionId, caseNumber: "search-census-citing" },
        { id: corpus.decisionId, caseNumber: "search-census" },
      ],
    }),
  },
  {
    id: "GET /v1/case/decisions/:decisionId/citations",
    sources: [
      "apps/api/src/handlers/case-law/public-routes.ts",
      "apps/api/src/handlers/case-law/decisions/list-citations.ts",
    ],
    request: ({ corpus }, headers) =>
      request(
        `/case/decisions/${corpus.decisionId}/citations?direction=incoming`,
        headers,
      ),
    expectedPayload: ({ corpus }) => ({
      type: "items",
      values: [
        {
          citationText: "search-census",
          decision: {
            id: corpus.citingDecisionId,
            caseNumber: "search-census-citing",
          },
        },
      ],
    }),
  },
  {
    id: "GET /v1/law/statutes/:documentId",
    sources: [
      "apps/api/src/handlers/legislation/public-routes.ts",
      "apps/api/src/handlers/legislation/get.ts",
    ],
    request: ({ corpus }, headers) =>
      request(`/law/statutes/${corpus.documentId}`, headers),
    expectedPayload: ({ corpus }) => ({
      type: "object",
      value: {
        id: corpus.documentId,
        eli: `census/${corpus.documentId}`,
        fulltext: ACCESS_MATRIX_STATUTE_TEXT,
      },
    }),
  },
  {
    id: "GET /v1/law/statutes/by-eli",
    sources: [
      "apps/api/src/handlers/legislation/public-routes.ts",
      "apps/api/src/handlers/legislation/by-eli.ts",
    ],
    request: ({ corpus }, headers) =>
      request(
        `/law/statutes/by-eli?eli=${encodeURIComponent(`census/${corpus.documentId}`)}`,
        headers,
      ),
    expectedPayload: ({ corpus }) => ({
      type: "object",
      value: {
        id: corpus.documentId,
        eli: `census/${corpus.documentId}`,
        fulltext: ACCESS_MATRIX_STATUTE_TEXT,
      },
    }),
  },
  {
    id: "GET /v1/law/statutes/:documentId/versions",
    sources: [
      "apps/api/src/handlers/legislation/public-routes.ts",
      "apps/api/src/handlers/legislation/versions.ts",
    ],
    request: ({ corpus }, headers) =>
      request(`/law/statutes/${corpus.documentId}/versions`, headers),
    expectedPayload: ({ corpus }) => ({
      type: "items",
      values: [
        {
          id: corpus.documentId,
          eli: `census/${corpus.documentId}`,
          isDefault: true,
        },
      ],
    }),
  },
] satisfies readonly (Pick<
  RouteAccessFixture,
  "request" | "sources" | "expectedPayload"
> & { id: VersionedPublicRouteId })[];

/** Declarations identify intended cells; execution evidence comes from the runner. */
export const ROUTE_ACCESS_FIXTURES: readonly RouteAccessFixture[] = [
  ...publicFixtures.map((fixture) => ({
    ...fixture,
    subject: "public-law" as const,
    testPath: ROUTE_ACCESS_MATRIX_TEST_PATH,
    sharedSources,
    sources: [...publicSources, ...fixture.sources],
    cells: publicCells,
    successStatus: 200 as const,
  })),
  {
    id: "GET /v1/me/professional-use",
    subject: "org-auth",
    testPath: ROUTE_ACCESS_MATRIX_TEST_PATH,
    sharedSources,
    sources: [
      "apps/api/src/handlers/me/routes.ts",
      "apps/api/src/handlers/me/professional-use.ts",
      "apps/api/src/db/schema/professional-use.ts",
    ],
    cells: ACTORS.map(({ actor, type }) => ({
      actor,
      expected: type === "anonymous" ? 401 : "allow",
    })),
    successStatus: 200,
    request: (_context, headers) => request("/me/professional-use", headers),
    expectedPayload: ({ acceptedAt }) => ({
      type: "object",
      value: {
        status: PROFESSIONAL_USE_STATUS.accepted,
        statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
        termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
        acceptedAt: acceptedAt.toISOString(),
      },
    }),
  },
  {
    id: "GET /v1/user-files/:fileId/content",
    subject: "document",
    testPath: ROUTE_ACCESS_MATRIX_TEST_PATH,
    sharedSources,
    sources: [
      "apps/api/src/handlers/user-files/routes.ts",
      "apps/api/src/handlers/user-files/read-content.ts",
      "apps/api/src/lib/audited-download.ts",
      "apps/api/src/lib/s3.ts",
    ],
    cells: ACTORS.map((actor) => {
      switch (actor.type) {
        case "anonymous":
          return { actor: actor.actor, expected: 401 };
        case "foreign-organization":
          return { actor: actor.actor, expected: 404 };
        case "owning-organization-role":
        case "organization-standing":
          return {
            actor: actor.actor,
            expected: roles[actor.role].authorize(DOCUMENT_READ_PERMISSIONS)
              .success
              ? "allow"
              : 403,
          };
        default:
          actor satisfies never;
          return panic("Unhandled route access actor");
      }
    }),
    successStatus: 302,
    request: ({ document }, headers) =>
      request(`/user-files/${document.id}/content`, headers),
    expectedPayload: ({ document }) => ({
      type: "redirect",
      objectKey: document.s3Key,
    }),
  },
];
