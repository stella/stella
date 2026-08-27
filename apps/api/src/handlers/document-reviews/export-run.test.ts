import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { toSafeId } from "@/api/lib/branded-types";
import { SPREADSHEET_EXPORT_LIMITS } from "@/api/lib/views/table-export";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import exportDocumentReviewRun from "./export-run";

type ExportDocumentReviewRunContext = Parameters<
  typeof exportDocumentReviewRun.handler
>[0];

const WORKSPACE_ID = toSafeId<"workspace">(
  "11111111-1111-4111-8111-111111111111",
);
const RUN_ID = toSafeId<"documentReviewRun">(
  "22222222-2222-4222-8222-222222222222",
);
const REFERENCE_FIELD_ID = toSafeId<"field">(
  "33333333-3333-4333-8333-333333333333",
);
const REFERENCE_WORKSPACE_ID = toSafeId<"workspace">(
  "66666666-6666-4666-8666-666666666666",
);

const FORBIDDEN_XML_CONTROLS = "\u0000\u0001\u0008\u000b\u000c\u000e\u001f";

const hasForbiddenXmlControl = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      codePoint < 0x20 &&
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d
    ) {
      return true;
    }
  }
  return false;
};

describe("document review run export", () => {
  test("sanitizes hostile XLSX cells before writing worksheet XML", async () => {
    const hostileTopic =
      FORBIDDEN_XML_CONTROLS +
      "x".repeat(SPREADSHEET_EXPORT_LIMITS.cellTextChars + 1);
    expect(hasForbiddenXmlControl(hostileTopic)).toBe(true);
    expect(Array.from(hostileTopic)).toHaveLength(
      SPREADSHEET_EXPORT_LIMITS.cellTextChars +
        1 +
        Array.from(FORBIDDEN_XML_CONTROLS).length,
    );

    let selectCallCount = 0;
    const { safeDb } = createScopedDbMock({
      query: {
        workspaces: { findMany: async () => [{ id: WORKSPACE_ID }] },
      },
      select: () => {
        selectCallCount += 1;
        if (selectCallCount === 1) {
          return {
            from: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: async () => [
                    {
                      id: RUN_ID,
                      targetName: "Draft agreement.docx",
                      basis: {
                        type: "references",
                        references: [
                          {
                            workspaceId: WORKSPACE_ID,
                            workspaceName: "Precedent matter",
                            entityId: toSafeId<"entity">(
                              "44444444-4444-4444-8444-444444444444",
                            ),
                            fileFieldId: REFERENCE_FIELD_ID,
                            entityVersionId: toSafeId<"entityVersion">(
                              "55555555-5555-4555-8555-555555555555",
                            ),
                            contentSha256: "a".repeat(64),
                            name: "Precedent agreement",
                          },
                        ],
                        perspective: { type: "neutral" },
                      },
                    },
                  ],
                }),
              }),
            }),
          };
        }

        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [
                  {
                    topicTitle: hostileTopic,
                    decision: "open",
                    payload: {
                      checkKind: "reference",
                      finding: {
                        findingId: "finding-1",
                        topicId: "topic-1",
                        issue: "Hostile spreadsheet text",
                        assessment: "different",
                        consensus: "single",
                        explanation: {
                          type: "comparison",
                          text: "Different wording.",
                        },
                        recommendation: null,
                        impact: "unknown",
                        severity: "medium",
                        targetCitations: [],
                        referenceCitations: [
                          {
                            fileFieldId: REFERENCE_FIELD_ID,
                            citations: [],
                          },
                        ],
                        fix: null,
                      },
                    },
                  },
                ],
              }),
            }),
          }),
        };
      },
    });
    const context = asTestRaw<ExportDocumentReviewRunContext>({
      memberRole: { role: "owner" },
      params: { workspaceId: WORKSPACE_ID, runId: RUN_ID },
      query: { format: "xlsx" },
      recordAuditEvent: async () => undefined,
      safeDb,
      session: { activeOrganizationId: "organization_test" },
      user: { id: "user_test" },
      workspaceId: WORKSPACE_ID,
    });

    const response = await exportDocumentReviewRun.handler(context);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      return;
    }
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("text");
    expect(sheet).toBeDefined();
    if (sheet === undefined) {
      return;
    }

    expect(hasForbiddenXmlControl(sheet)).toBe(false);
    const topicCell =
      /<c r="A2"[^>]*><is><t[^>]*>(?<value>[\s\S]*?)<\/t>/u.exec(sheet)
        ?.groups?.["value"];
    expect(topicCell).toBeDefined();
    if (topicCell === undefined) {
      return;
    }
    expect(Array.from(topicCell)).toHaveLength(
      SPREADSHEET_EXPORT_LIMITS.cellTextChars,
    );
    expect(topicCell).toEndWith("\n[truncated]");
  });

  test("omits reference text from a matter the caller cannot read", async () => {
    let selectCallCount = 0;
    const { safeDb } = createScopedDbMock({
      // The reference matter is no longer readable, so row security returns
      // none of the matters the run pinned.
      query: { workspaces: { findMany: async () => [] } },
      select: () => {
        selectCallCount += 1;
        if (selectCallCount === 1) {
          return {
            from: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: async () => [
                    {
                      id: RUN_ID,
                      targetName: "Draft agreement.docx",
                      basis: {
                        type: "references",
                        references: [
                          {
                            workspaceId: REFERENCE_WORKSPACE_ID,
                            workspaceName: "Precedent matter",
                            entityId: toSafeId<"entity">(
                              "44444444-4444-4444-8444-444444444444",
                            ),
                            fileFieldId: REFERENCE_FIELD_ID,
                            entityVersionId: toSafeId<"entityVersion">(
                              "55555555-5555-4555-8555-555555555555",
                            ),
                            contentSha256: "a".repeat(64),
                            name: "Precedent agreement",
                          },
                        ],
                        perspective: { type: "neutral" },
                      },
                    },
                  ],
                }),
              }),
            }),
          };
        }

        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [
                  {
                    topicTitle: "Liability cap",
                    decision: "open",
                    payload: {
                      checkKind: "reference",
                      finding: {
                        findingId: "finding-1",
                        topicId: "topic-1",
                        issue: "Liability cap",
                        assessment: "different",
                        consensus: "single",
                        explanation: {
                          type: "comparison",
                          text: "Different cap.",
                        },
                        recommendation: null,
                        impact: "unknown",
                        severity: "medium",
                        targetCitations: [
                          { blockId: "target-1", text: "Draft wording." },
                        ],
                        referenceCitations: [
                          {
                            fileFieldId: REFERENCE_FIELD_ID,
                            citations: [
                              {
                                blockId: "reference-1",
                                text: "Precedent wording.",
                              },
                            ],
                          },
                        ],
                        fix: null,
                      },
                    },
                  },
                ],
              }),
            }),
          }),
        };
      },
    });
    const context = asTestRaw<ExportDocumentReviewRunContext>({
      memberRole: { role: "owner" },
      params: { workspaceId: WORKSPACE_ID, runId: RUN_ID },
      query: { format: "csv" },
      recordAuditEvent: async () => undefined,
      safeDb,
      session: { activeOrganizationId: "organization_test" },
      user: { id: "user_test" },
      workspaceId: WORKSPACE_ID,
    });

    const response = await exportDocumentReviewRun.handler(context);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      return;
    }
    const csv = await response.text();
    expect(csv).toContain("Draft wording.");
    expect(csv).not.toContain("Precedent wording.");
  });
});
