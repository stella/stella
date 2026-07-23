import { describe, expect, mock, test } from "bun:test";

import type { ReviewFinding } from "@/api/handlers/playbooks/review-grade";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const findings: ReviewFinding[] = [
  {
    positionId: "compliant",
    issue: "Compliant position",
    severity: "low",
    verdict: "compliant",
    extracted: null,
    rationale: null,
    citations: [],
    fix: null,
  },
  {
    positionId: "fallback",
    issue: "Fallback position",
    severity: "medium",
    verdict: "fallback",
    extracted: null,
    rationale: null,
    citations: [],
    fix: null,
  },
  {
    positionId: "deviation",
    issue: "Deviating position",
    severity: "high",
    verdict: "deviation",
    extracted: null,
    rationale: null,
    citations: [],
    fix: null,
  },
  {
    positionId: "missing",
    issue: "Missing position",
    severity: "blocker",
    verdict: "missing",
    extracted: null,
    rationale: null,
    citations: [],
    fix: null,
  },
  {
    positionId: "extract",
    issue: "Extract-only position",
    severity: "low",
    verdict: null,
    extracted: { text: "30 days", value: "30 days" },
    rationale: null,
    citations: [],
    fix: null,
  },
];

const buildFindingsMock = mock(async () => findings);

void mock.module("@/api/handlers/playbooks/review-grade", () => ({
  buildFindings: buildFindingsMock,
}));

// The handler performs its normal provider-availability preflight before it
// reaches the mocked grading boundary. Supply inert instance credentials so
// the test exercises the review response contract without a live AI call.
process.env["AI_PROVIDER"] = "google";
process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "test";

const { default: reviewPlaybook } =
  await import("@/api/handlers/playbooks/review");

type ReviewContext = Parameters<typeof reviewPlaybook.handler>[0];

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000002",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000003");
const playbookId = toSafeId<"playbookDefinition">(
  "00000000-0000-0000-0000-000000000004",
);
const entityId = toSafeId<"entity">("00000000-0000-0000-0000-000000000005");
const entityVersionId = toSafeId<"entityVersion">(
  "00000000-0000-0000-0000-000000000006",
);
const fileFieldId = toSafeId<"field">("00000000-0000-0000-0000-000000000007");

describe("single-document playbook review", () => {
  test("returns every review result so the client can compute complete totals", async () => {
    let auditedReview: unknown;
    const recordAuditEvent: AuditRecorder = async (_tx, event) => {
      const auditEvent = Array.isArray(event) ? event.at(0) : event;
      auditedReview = auditEvent?.changes?.["review"]?.new;
    };
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        playbookDefinitions: {
          findFirst: async () => ({
            scope: null,
            positions: {
              version: 2 as const,
              items: [
                {
                  mode: "extract" as const,
                  sourceId: "00000000-0000-0000-0000-000000000008",
                  issue: "Manual review",
                  ask: {
                    question: "",
                    content: { version: 1 as const, type: "text" as const },
                  },
                  enabled: true,
                },
              ],
            },
          }),
        },
        entities: {
          findFirst: async () => ({
            id: entityId,
            currentVersion: {
              id: entityVersionId,
              fields: [
                {
                  id: fileFieldId,
                  propertyId: toSafeId<"property">(
                    "00000000-0000-0000-0000-000000000009",
                  ),
                  content: {
                    version: 1 as const,
                    type: "file" as const,
                    id: "00000000-0000-0000-0000-000000000010",
                    fileName: "contract.pdf",
                    mimeType: "application/pdf",
                    sizeBytes: 1024,
                    encrypted: false,
                    sha256Hex: "a".repeat(64),
                    pdfFileId: null,
                  },
                },
              ],
            },
          }),
        },
      },
    });

    const result = await reviewPlaybook.handler(
      asTestRaw<ReviewContext>({
        body: { entityId, fileFieldId },
        createAuditRecorder: () => recordAuditEvent,
        memberRole: { role: "owner" },
        orgAIConfig: null,
        params: { playbookId, workspaceId },
        promptCachingEnabled: false,
        recordAuditEvent,
        request: new Request(
          `https://example.test/workspaces/${workspaceId}/playbooks/${playbookId}/review`,
        ),
        route: "/workspaces/:workspaceId/playbooks/:playbookId/review",
        safeDb,
        scopedDb,
        session: { activeOrganizationId: organizationId },
        user: { id: userId },
        workspaceId,
      }),
    );

    expect(result).toEqual(findings);
    expect(auditedReview).toEqual({
      documentId: entityId,
      findingCount: findings.length,
    });
  });
});
