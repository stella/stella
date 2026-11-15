// The STELLA_RUN_POSTGRES_TESTS runner also executes this suite.
/**
 * The graph's agent tools through their handlers and their own input
 * schemas: what a model sends is what these parse, and every refusal names
 * the next call.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createTestState } from "@stll/test-state";

import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import listGraphNeighbours from "@/api/handlers/lists/graph/neighbours/list";
import listGraphNodes from "@/api/handlers/lists/graph/nodes/list";
import listGraphPaths from "@/api/handlers/lists/graph/paths/list";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { isRecord } from "@/api/lib/type-guards";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";
import {
  seedGraphCase,
  seedGraphReviewer,
} from "@/api/tests/helpers/graph-case";
import type { SeededGraphCase } from "@/api/tests/helpers/graph-case";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const testState = createTestState({ file: import.meta.path, config: env });
let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
let matter: SeededGraphCase;
let other: SeededGraphCase;

const seed = async (): Promise<SeededGraphCase> =>
  await seedGraphCase({
    db: testDb,
    organizationId,
    userId,
    workspaceId: createSafeId<"workspace">(),
    reference: Bun.randomUUIDv7().slice(-8),
  });

testState.beforeAll(async () => {
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig(
    "API_FEATURE_ACCESS_GRANTS",
    organizationFeatureGrants(organizationId, [
      LEGAL_LISTS_FEATURE_ID,
      LIST_VERIFICATION_FEATURE_ID,
    ]),
  );
  testDb = await getTestDb();
  await seedGraphReviewer({ db: testDb, organizationId, userId });
  matter = await seed();
  other = await seed();
});

afterAll(async () => {
  await deleteOrganizationsForTest(testDb, [organizationId]);
  await releaseTestDb();
});

type Call = {
  workspaceId: SafeId<"workspace">;
  audit: AuditEvent[];
};

const contextOf = (call: Call) => ({
  audit: auditRecorderDouble((events) => {
    call.audit.push(...events);
  }),
  scopedDb: NO_DB,
  workspaceId: call.workspaceId,
  session: { activeOrganizationId: organizationId },
  user: { id: userId },
  safeDb: createSafeDb(testDb, [call.workspaceId], organizationId, userId),
});

type Outcome =
  | { type: "rejected"; issues: readonly v.BaseIssue<unknown>[] }
  | { type: "handled"; result: unknown };

/** Each tool, run as the reviewer in one matter with its query parsed by
 *  the handler's own schema, as every transport does. */
const TOOLS = {
  nodes: async (query: unknown, call: Call): Promise<Outcome> => {
    const parsed = v.safeParse(listGraphNodes.config.query, query);
    return parsed.success
      ? {
          type: "handled",
          result: await listGraphNodes.handler(
            createTestHandlerContext<
              Parameters<typeof listGraphNodes.handler>[0]
            >({ ...contextOf(call), query: parsed.output }),
          ),
        }
      : { type: "rejected", issues: parsed.issues };
  },
  neighbours: async (query: unknown, call: Call): Promise<Outcome> => {
    const parsed = v.safeParse(listGraphNeighbours.config.query, query);
    return parsed.success
      ? {
          type: "handled",
          result: await listGraphNeighbours.handler(
            createTestHandlerContext<
              Parameters<typeof listGraphNeighbours.handler>[0]
            >({ ...contextOf(call), query: parsed.output }),
          ),
        }
      : { type: "rejected", issues: parsed.issues };
  },
  paths: async (query: unknown, call: Call): Promise<Outcome> => {
    const parsed = v.safeParse(listGraphPaths.config.query, query);
    return parsed.success
      ? {
          type: "handled",
          result: await listGraphPaths.handler(
            createTestHandlerContext<
              Parameters<typeof listGraphPaths.handler>[0]
            >({ ...contextOf(call), query: parsed.output }),
          ),
        }
      : { type: "rejected", issues: parsed.issues };
  },
} as const;

const invoke = async (
  tool: keyof typeof TOOLS,
  rawQuery: Record<string, unknown>,
  given?: Call,
): Promise<Outcome> =>
  await TOOLS[tool](
    rawQuery,
    given ?? { workspaceId: matter.workspaceId, audit: [] },
  );

/** A refusal, as the handler answers one: its status and its body. */
type Refusal = { status: number; code: unknown; hint: unknown };

const refusalOf = (value: unknown): Refusal | null => {
  if (!isRecord(value) || typeof value["code"] !== "number") {
    return null;
  }
  const response = value["response"];
  return isRecord(response)
    ? { status: value["code"], code: response["code"], hint: response["hint"] }
    : null;
};

const okValue = (outcome: Outcome): unknown => {
  if (outcome.type !== "handled" || refusalOf(outcome.result) !== null) {
    throw new Error(`expected a result, got ${JSON.stringify(outcome)}`);
  }
  return outcome.result;
};

const errorOf = (outcome: Outcome): Refusal => {
  const refusal = outcome.type === "handled" ? refusalOf(outcome.result) : null;
  if (refusal === null) {
    throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
  }
  return refusal;
};

describe("graph agent tools", () => {
  test("a lookup finds the fact, the claim and the document by their words and audits the claim's delivery", async () => {
    const call: Call = { workspaceId: matter.workspaceId, audit: [] };
    const found = okValue(await invoke("nodes", { text: "cargo" }, call));
    expect(found).toMatchObject({
      nodes: [
        { kind: "fact", id: matter.facts.damage },
        { kind: "claim", id: matter.claims.undamaged, runId: matter.runId },
        { kind: "document", id: matter.documents.damage },
      ],
      nextCursor: null,
    });
    // The claim's words are the statement's text, so the run's read is
    // recorded as a delivery of that document.
    expect(call.audit).toMatchObject([
      { resourceId: matter.statementId, metadata: { runId: matter.runId } },
    ]);
  });

  test("a claim's conflicting fact and the passage it comes from, one hop at a time", async () => {
    const conflicts = okValue(
      await invoke("neighbours", {
        nodeKind: "claim",
        nodeId: matter.claims.undamaged,
        stance: "conflicts",
      }),
    );
    expect(conflicts).toMatchObject({
      summary: [
        { kind: "cites", stance: "conflicts", decision: "proposed", count: 1 },
      ],
      edges: [
        {
          kind: "cites",
          stance: "conflicts",
          neighbour: { kind: "fact", id: matter.facts.damage },
          producer: { kind: "run", id: matter.runId },
          quote: { text: "The cargo was discharged in perfect condition." },
        },
      ],
      nextCursor: null,
    });
    const source = okValue(
      await invoke("neighbours", {
        nodeKind: "fact",
        nodeId: matter.facts.damage,
        edgeKind: "sourced-from",
      }),
    );
    expect(source).toMatchObject({
      edges: [
        {
          neighbour: { kind: "document", id: matter.documents.damage },
          quote: {
            text: "Hold 2: seawater ingress, 41 pallets wet and unsaleable.",
            documentName: "Cargo survey report.pdf",
            locator: { type: "pdf-page", pageNumber: 1 },
          },
        },
      ],
    });
  });

  test("a walk from a claim reaches the documents its facts come from", async () => {
    const walk = okValue(
      await invoke("paths", {
        nodeKind: "claim",
        nodeId: matter.claims.paid,
        depth: "2",
      }),
    );
    expect(walk).toMatchObject({
      truncated: false,
      paths: [
        { nodes: [{ id: matter.claims.paid }, { id: matter.facts.payment }] },
        {
          nodes: [
            { id: matter.claims.paid },
            { id: matter.facts.payment },
            { id: matter.documents.payment },
          ],
        },
      ],
    });
  });

  test("every refusal names the next call", async () => {
    expect(
      errorOf(await invoke("nodes", { text: "cargo", cursor: "x" })),
    ).toMatchObject({ status: 400, code: "invalid_cursor" });
    const unknown = errorOf(
      await invoke("neighbours", {
        nodeKind: "fact",
        nodeId: createSafeId<"entity">(),
      }),
    );
    expect(unknown).toMatchObject({ status: 404, code: "not_found" });
    expect(String(unknown.hint)).toContain("lists.graph.nodes.list");
    // The bounds and the closed vocabularies are the schema's.
    for (const [tool, query] of [
      ["paths", { nodeKind: "claim", nodeId: matter.claims.paid, depth: "4" }],
      ["paths", { nodeKind: "claim", nodeId: matter.claims.paid, limit: "51" }],
      ["neighbours", { nodeKind: "person", nodeId: matter.facts.damage }],
      [
        "neighbours",
        { nodeKind: "fact", nodeId: matter.facts.damage, stance: "maybe" },
      ],
      ["nodes", { text: "" }],
    ] as const) {
      expect((await invoke(tool, query)).type).toBe("rejected");
    }
  });

  test("a matter's nodes are not found from another matter", async () => {
    const crossed = errorOf(
      await invoke(
        "paths",
        { nodeKind: "fact", nodeId: matter.facts.damage },
        { workspaceId: other.workspaceId, audit: [] },
      ),
    );
    expect(crossed).toMatchObject({ status: 404, code: "not_found" });
    const lookup = okValue(
      await invoke(
        "nodes",
        { text: "cargo" },
        { workspaceId: other.workspaceId, audit: [] },
      ),
    );
    expect(lookup).toMatchObject({
      nodes: [
        { kind: "fact", id: other.facts.damage },
        { kind: "claim", id: other.claims.undamaged },
        { kind: "document", id: other.documents.damage },
      ],
    });
  });
});
