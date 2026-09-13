import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { env } from "@/api/env";
import lookupResearchAnswers from "@/api/handlers/case-law/research/answers-lookup";
import runResearchAnswers from "@/api/handlers/case-law/research/answers-run";
import createResearchColumn from "@/api/handlers/case-law/research/columns-create";
import deleteResearchColumn from "@/api/handlers/case-law/research/columns-delete";
import listResearchColumns from "@/api/handlers/case-law/research/columns-list";
import reorderResearchColumns from "@/api/handlers/case-law/research/columns-reorder";
import suggestResearchColumnPrompt from "@/api/handlers/case-law/research/columns-suggest-prompt";
import updateResearchColumn from "@/api/handlers/case-law/research/columns-update";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type { MemberRole } from "@/api/lib/member-roles";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { discoverSafeHandlers } from "../../../scripts/lib/enumerate-safe-handlers";

/**
 * Case-law question columns are organization data and every answer run spends
 * AI budget, so they sit behind the `caseLawResearch` grant rather than the
 * baseline `workspace:["read"]` every role holds. This pins the declared grant
 * per endpoint and drives the real handlers to prove the framework refuses a
 * member of an unprivileged role before any work happens.
 */

const RESEARCH_DIR = "apps/api/src/handlers/case-law/research/";

const GRANTED_ROLES = ["owner", "admin", "member"] as const;
const DENIED_ROLES = ["intern", "external"] as const;

const MUTATIONS = {
  "answers-run.ts": runResearchAnswers,
  "columns-create.ts": createResearchColumn,
  "columns-delete.ts": deleteResearchColumn,
  "columns-reorder.ts": reorderResearchColumns,
  "columns-suggest-prompt.ts": suggestResearchColumnPrompt,
  "columns-update.ts": updateResearchColumn,
} as const;

/** Reads: every role may look at the columns and the answers already there. */
const READS = {
  "columns-list.ts": listResearchColumns,
  "answers-lookup.ts": lookupResearchAnswers,
} as const;

const refusingDb: SafeDb = async <T>() =>
  Result.err<T, SafeDbError>(
    new DatabaseError({ message: "a denied call must not reach the database" }),
  );

const contextForRole = (role: MemberRole): unknown => ({
  request: new Request("https://example.test/case/research"),
  route: "/case/research",
  body: {},
  params: {},
  user: { id: toSafeId<"user">("019e7000-0000-7000-8000-000000000001") },
  session: {
    activeOrganizationId: toSafeId<"organization">(
      "019e7000-0000-7000-8000-000000000002",
    ),
  },
  memberRole: { role },
  safeDb: refusingDb,
  scopedDb: async () => {
    throw new DatabaseError({ message: "scopedDb must not be called" });
  },
  getActiveWorkspaceIds: async () => [],
  getAccessibleWorkspaces: async () => [],
  getWorkspaceAccess: async () => null,
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  promptCachingEnabled: false,
  recordAuditEvent: async () => undefined,
  createAuditRecorder: () => async () => undefined,
});

describe("case-law research permissions", () => {
  test("every research endpoint is covered by this test", async () => {
    const { endpoints } = await discoverSafeHandlers();
    const discovered = endpoints
      .filter(({ id }) => id.startsWith(RESEARCH_DIR))
      .map(({ id }) => id.slice(RESEARCH_DIR.length));

    expect(discovered.toSorted()).toEqual(
      [...Object.keys(MUTATIONS), ...Object.keys(READS)].toSorted(),
    );
  });

  test("each mutation declares the research grant it needs", () => {
    const declared = Object.fromEntries(
      Object.entries(MUTATIONS).map(([file, endpoint]) => [
        file,
        endpoint.config.permissions,
      ]),
    );

    expect(declared).toEqual({
      "answers-run.ts": { caseLawResearch: ["run"] },
      "columns-create.ts": { caseLawResearch: ["create"] },
      "columns-delete.ts": { caseLawResearch: ["delete"] },
      "columns-reorder.ts": { caseLawResearch: ["update"] },
      "columns-suggest-prompt.ts": { caseLawResearch: ["create"] },
      "columns-update.ts": { caseLawResearch: ["update"] },
    });
  });

  test("reads stay on the baseline grant and affirm themselves reads", () => {
    const declared = Object.fromEntries(
      Object.entries(READS).map(([file, endpoint]) => [
        file,
        {
          permissions: endpoint.config.permissions,
          access: endpoint.config.access,
        },
      ]),
    );

    expect(declared).toEqual({
      "answers-lookup.ts": {
        permissions: { workspace: ["read"] },
        access: "read",
      },
      "columns-list.ts": {
        permissions: { workspace: ["read"] },
        access: "read",
      },
    });
  });

  // Every mutation, including the two the finding named: running answers
  // (which spends AI budget) and deleting a column (which drops another
  // member's question and its answers).
  test("a role without the grant is refused, before any database work", async () => {
    for (const [file, endpoint] of Object.entries(MUTATIONS)) {
      for (const role of DENIED_ROLES) {
        const result = await endpoint.handler(asTestRaw(contextForRole(role)));
        if (!("code" in result)) {
          throw new Error(`${file} as ${role}: expected a status response`);
        }
        expect({
          file,
          role,
          code: result.code,
          body: result.response,
        }).toEqual({
          file,
          role,
          code: 403,
          body: { code: "forbidden", message: "Forbidden" },
        });
      }
    }
  });

  test("staff hold every grant the research endpoints ask for", () => {
    for (const [file, endpoint] of Object.entries(MUTATIONS)) {
      for (const role of GRANTED_ROLES) {
        expect({
          file,
          role,
          granted: hasMemberPermission({ role }, endpoint.config.permissions),
        }).toEqual({ file, role, granted: true });
      }
    }
  });
});

/**
 * The run endpoint spends nothing itself: its detached runner meters every
 * model call under `case_law` at the standard tier. So the framework
 * pre-flight has to price the request that way and refuse it before the queue
 * marks cells pending, or an organization with no budget left is charged for
 * nothing and keeps rows pending against a run that can never answer them.
 */
describe("an answer run is priced before it claims cells", () => {
  /** A ledger holding no entitlement row for the organization. */
  const noEntitlementTx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  };

  test("refuses the run at the case-law price, before the queue is touched", async () => {
    const previousEnforcement = env.USAGE_ENFORCEMENT_ENABLED;
    const previousProvider = env.AI_PROVIDER;
    const previousAnthropicKey = env.ANTHROPIC_API_KEY;
    env.USAGE_ENFORCEMENT_ENABLED = true;
    env.AI_PROVIDER = "anthropic";
    env.ANTHROPIC_API_KEY = "sk-test";
    try {
      let transactions = 0;
      const unentitledDb: SafeDb = async <T>(
        fn: (tx: never) => Promise<T>,
      ): Promise<Result<T, SafeDbError>> => {
        transactions += 1;
        return Result.ok(await fn(asTestRaw(noEntitlementTx)));
      };

      const result = await runResearchAnswers.handler(
        asTestRaw({
          ...asTestRaw<Record<string, unknown>>(contextForRole("owner")),
          body: {
            decisionIds: [
              toSafeId<"caseLawDecision">(
                "019e7000-0000-7000-8000-0000000000a1",
              ),
            ],
          },
          safeDb: unentitledDb,
        }),
      );

      if (!("code" in result)) {
        throw new Error("expected the pre-flight to return a status response");
      }
      expect({ code: result.code, body: result.response }).toEqual({
        code: 402,
        body: {
          code: "usage_limit_exceeded",
          message: "Organisation has no active usage entitlement",
          reason: "no_entitlement",
          // 8 units for `case_law`, times the 1.5 standard-tier multiplier:
          // the chat meter the neighbouring endpoints declare would cost 2.
          required: 12,
          available: 0,
        },
      });
      // Only the pre-flight read: the handler body, which claims the cells,
      // never opened a transaction of its own.
      expect(transactions).toBe(1);
    } finally {
      env.USAGE_ENFORCEMENT_ENABLED = previousEnforcement;
      env.AI_PROVIDER = previousProvider;
      env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  });
});
