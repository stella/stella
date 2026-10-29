import { panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { DOCUMENT_TOOL_SET } from "@/api/mcp/document-tools";
import type { McpToolName } from "@/api/mcp/static-tool-names";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { seedEntityReadScaling } from "@/api/tests/read-scaling/entity-fixture";
import {
  measurePlainWebHandoff,
  measureWebHandoff,
} from "@/api/tests/read-scaling/handoff";

import { measureVerifyQuote } from "./verify-quote";

type ReadFixture = Awaited<ReturnType<typeof seedEntityReadScaling>>;

export const mcpScalingScenarios = [
  {
    name: "verify_quote" satisfies McpToolName,
    kind: "stored-decision" as const,
    measure: measureVerifyQuote,
  },
  {
    name: "list_documents" satisfies McpToolName,
    kind: "database-page" as const,
    measure: async (fixture: ReadFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const scopedDb: ScopedDb = async (work) =>
          (await fixture.safeDb(work)).unwrap();
        const response = await DOCUMENT_TOOL_SET.handlers.list_documents({
          args: { matter_id: fixture.workspaceId, limit: 10 },
          context: asTestRaw<
            Parameters<
              typeof DOCUMENT_TOOL_SET.handlers.list_documents
            >[0]["context"]
          >({
            userId: fixture.userId,
            organizationId: fixture.organizationId,
            memberRole: "owner",
            accessibleWorkspaceIdSet: new Set([fixture.workspaceId]),
            scopedDb,
          }),
        });
        if (
          !("egress" in response) ||
          response.egress !== "structured" ||
          !isRecord(response.payload) ||
          !isUnknownArray(response.payload["documents"])
        ) {
          return panic(
            "list_documents scaling requires a successful egress payload",
          );
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response.payload)),
          rows: response.payload["documents"].length,
        };
      }),
  },
  {
    name: "mint_web_handoff" satisfies McpToolName,
    kind: "credential-mint" as const,
    measure: measureWebHandoff,
    measurePlain: measurePlainWebHandoff,
  },
];
