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
                        playbook: {
                          definitionId: null,
                          versionId: null,
                          provenance: "ephemeral",
                          definitionSnapshot: {
                            name: "Positions confirmed for this review",
                            positions: { version: 3, items: [] },
                          },
                        },
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
                    positionTitle: hostileTopic,
                    decision: "open",
                    payload: {
                      finding: {
                        positionId: "11111111-1111-4111-8111-1111111111aa",
                        issue: "Hostile spreadsheet text",
                        severity: "medium",
                        standardSource: "reference",
                        verdict: "deviation",
                        delta: { kind: "language" },
                        extracted: null,
                        consensus: "single",
                        rationale: "Different wording.",
                        explanation: {
                          type: "comparison",
                          text: "Different wording.",
                        },
                        recommendation: null,
                        impact: "unknown",
                        citations: [],
                        referenceCitations: [
                          {
                            fileFieldId: REFERENCE_FIELD_ID,
                            passages: [],
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
    const POSITION_ID = "11111111-1111-4111-8111-1111111111aa";
    const PASSAGE_ID = "77777777-7777-4777-8777-777777777777";
    let selectCallCount = 0;
    const { safeDb } = createScopedDbMock({
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
                        playbook: {
                          definitionId: null,
                          versionId: null,
                          provenance: "ephemeral",
                          definitionSnapshot: {
                            name: "Positions confirmed for this review",
                            positions: {
                              version: 3,
                              items: [
                                {
                                  mode: "graded",
                                  sourceId: POSITION_ID,
                                  issue: "Liability cap",
                                  severity: "medium",
                                  standard: {
                                    source: "reference",
                                    termKind: "language",
                                    passages: [
                                      {
                                        id: PASSAGE_ID,
                                        workspaceId: REFERENCE_WORKSPACE_ID,
                                        entityId: toSafeId<"entity">(
                                          "44444444-4444-4444-8444-444444444444",
                                        ),
                                        fileFieldId: REFERENCE_FIELD_ID,
                                        entityVersionId:
                                          toSafeId<"entityVersion">(
                                            "55555555-5555-4555-8555-555555555555",
                                          ),
                                        blockId: "reference-1",
                                      },
                                    ],
                                  },
                                  ask: { mode: "auto" },
                                  enabled: true,
                                },
                              ],
                            },
                          },
                        },
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

        if (selectCallCount === 2) {
          return {
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: async () => [
                    {
                      positionTitle: "Liability cap",
                      decision: "open",
                      payload: {
                        finding: {
                          positionId: POSITION_ID,
                          issue: "Liability cap",
                          severity: "medium",
                          standardSource: "reference",
                          verdict: "deviation",
                          delta: { kind: "language" },
                          extracted: null,
                          consensus: "single",
                          rationale: "Different cap.",
                          explanation: {
                            type: "comparison",
                            text: "Different cap.",
                          },
                          recommendation: null,
                          impact: "unknown",
                          citations: [
                            { blockId: "target-1", text: "Draft wording." },
                          ],
                          referenceCitations: [
                            {
                              fileFieldId: REFERENCE_FIELD_ID,
                              passages: [
                                { id: PASSAGE_ID, blockId: "reference-1" },
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
        }

        // The passage read runs through the caller's own scoped transaction;
        // row security answers none of the matters the run pinned, so the
        // passage that would say "Precedent wording." is simply absent.
        return {
          from: () => ({
            where: async () => [],
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
