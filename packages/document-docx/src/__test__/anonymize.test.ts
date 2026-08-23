import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { CALLER_DETECTION_MAX_COUNT } from "@stll/anonymize";

import {
  DOCX_ANONYMIZATION_MAX_CALLER_DETECTIONS,
  DOCX_COVERAGE_MODES,
  DocxAnonymizationError,
  anonymizeDocx,
  extractDocxText,
  type DocxAnonymizationSession,
} from "../index";

const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const docx = (
  body: string,
  documentRelationships: readonly string[] = [],
): Uint8Array =>
  zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${DOCUMENT_CONTENT_TYPE}"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:r="${RELATIONSHIP_NAMESPACE}"><w:body>${body}</w:body></w:document>`,
    ),
    ...(documentRelationships.length === 0
      ? {}
      : {
          "word/_rels/document.xml.rels": strToU8(
            `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}">${documentRelationships.join("")}</Relationships>`,
          ),
        }),
  });

const fullCoveragePolicy = {
  coverage: { mode: DOCX_COVERAGE_MODES.requireFull },
} as const;

describe("anonymizeDocx", () => {
  test("shares the caller-detection limit with session planning", () => {
    expect(DOCX_ANONYMIZATION_MAX_CALLER_DETECTIONS).toBe(
      CALLER_DETECTION_MAX_COUNT,
    );
  });

  test("rewrites a caller detection and returns an audit-safe summary", () => {
    const document = docx(
      "<w:p><w:r><w:t>Ali</w:t></w:r><w:r><w:t>ce signed.</w:t></w:r></w:p>",
    );
    const block = extractDocxText(document).blocks.at(0);
    if (block === undefined) {
      throw new Error("test fixture must contain a block");
    }
    let committed = false;
    const session: DocxAnonymizationSession = {
      sessionId: () => "case_1",
      planTextBatchWithCallerDetections: ({ inputs }) => {
        expect(inputs).toEqual([
          {
            fullText: "Alice signed.",
            detections: [
              {
                start: 0,
                end: 5,
                label: "person",
                score: 0.99,
                providerId: "review-service",
                detectionId: "person-1",
              },
            ],
          },
        ]);
        return {
          blocks: [
            {
              replacements: [
                {
                  start: 0,
                  end: 5,
                  replacement: "[PERSON_case%5F1_1]",
                },
              ],
              entityCount: 1,
              callerEntityCount: 1,
            },
          ],
          commit: () => {
            committed = true;
          },
        };
      },
    };

    const result = anonymizeDocx({
      document,
      session,
      expectedSessionId: "case_1",
      policy: fullCoveragePolicy,
      callerDetections: [
        {
          location: block.location,
          expectedText: block.text,
          detections: [
            {
              start: 0,
              end: 5,
              label: "person",
              score: 0.99,
              providerId: "review-service",
              detectionId: "person-1",
            },
          ],
        },
      ],
    });

    expect(committed).toBeTrue();
    expect(extractDocxText(result.document).blocks.at(0)?.text).toBe(
      "[PERSON_case%5F1_1] signed.",
    );
    expect(result.summary).toMatchObject({
      contractVersion: 1,
      sessionId: "case_1",
      blockCount: 1,
      rewrittenBlockCount: 1,
      appliedReplacementCount: 1,
      entityCount: 1,
      callerDetectionCount: 1,
      retainedCallerDetectionCount: 1,
      coverage: { status: "full" },
    });
    expect(JSON.stringify(result.summary)).not.toContain("Alice");
  });

  test("does not commit the session when the DOCX rewrite fails", () => {
    const document = docx(
      "<w:p><w:r><w:t>Alice</w:t><w:tab/><w:t>Smith</w:t></w:r></w:p>",
    );
    let committed = false;
    const session: DocxAnonymizationSession = {
      sessionId: () => "case_1",
      planTextBatchWithCallerDetections: () => ({
        blocks: [
          {
            replacements: [
              { start: 0, end: 11, replacement: "[PERSON_case%5F1_1]" },
            ],
            entityCount: 1,
            callerEntityCount: 0,
          },
        ],
        commit: () => {
          committed = true;
        },
      }),
    };

    expect(() =>
      anonymizeDocx({
        document,
        session,
        expectedSessionId: "case_1",
        policy: fullCoveragePolicy,
      }),
    ).toThrow("contiguous non-revision text segments");
    expect(committed).toBeFalse();
  });

  test("requires explicit opt-in for partial extraction coverage", () => {
    const document = docx(
      '<w:p><w:ins w:id="1"><w:r><w:t>Alice</w:t></w:r></w:ins></w:p>',
    );
    let planned = false;
    const session: DocxAnonymizationSession = {
      sessionId: () => "case_1",
      planTextBatchWithCallerDetections: () => {
        planned = true;
        return {
          blocks: [{ replacements: [], entityCount: 0, callerEntityCount: 0 }],
          commit: () => {},
        };
      },
    };

    expect(() =>
      anonymizeDocx({
        document,
        session,
        expectedSessionId: "case_1",
        policy: fullCoveragePolicy,
      }),
    ).toThrow(DocxAnonymizationError);
    expect(planned).toBeFalse();

    const result = anonymizeDocx({
      document,
      session,
      expectedSessionId: "case_1",
      policy: {
        coverage: { mode: DOCX_COVERAGE_MODES.allowPartial },
      },
    });
    expect(result.summary.coverage.status).toBe("partial");
  });

  test("treats hyperlinks as partial while relationship targets are not rewritten", () => {
    const document = docx(
      '<w:p><w:hyperlink r:id="rId2"><w:r><w:t>Contact</w:t></w:r></w:hyperlink></w:p>',
      [
        `<Relationship Id="rId2" Type="${RELATIONSHIP_NAMESPACE}/hyperlink" Target="mailto:person@example.test" TargetMode="External"/>`,
      ],
    );
    let planned = false;
    const session: DocxAnonymizationSession = {
      sessionId: () => "case_1",
      planTextBatchWithCallerDetections: () => {
        planned = true;
        return {
          blocks: [{ replacements: [], entityCount: 0, callerEntityCount: 0 }],
          commit: () => {},
        };
      },
    };

    expect(() =>
      anonymizeDocx({
        document,
        session,
        expectedSessionId: "case_1",
        policy: fullCoveragePolicy,
      }),
    ).toThrow(DocxAnonymizationError);
    expect(planned).toBeFalse();

    const result = anonymizeDocx({
      document,
      session,
      expectedSessionId: "case_1",
      policy: {
        coverage: { mode: DOCX_COVERAGE_MODES.allowPartial },
      },
    });
    expect(result.summary.coverage).toMatchObject({
      status: "partial",
      counts: { hyperlinkTextSegmentCount: 1 },
    });
  });

  test("rejects stale caller-detection block locations before planning", () => {
    const document = docx("<w:p><w:r><w:t>Alice signed.</w:t></w:r></w:p>");
    const block = extractDocxText(document).blocks.at(0);
    if (block === undefined) {
      throw new Error("test fixture must contain a block");
    }
    let planned = false;
    const session: DocxAnonymizationSession = {
      sessionId: () => "case_1",
      planTextBatchWithCallerDetections: () => {
        planned = true;
        throw new Error("must not plan stale input");
      },
    };

    expect(() =>
      anonymizeDocx({
        document,
        session,
        expectedSessionId: "case_1",
        policy: fullCoveragePolicy,
        callerDetections: [
          {
            location: block.location,
            expectedText: "Changed text",
            detections: [],
          },
        ],
      }),
    ).toThrow("no longer matches");
    expect(planned).toBeFalse();
  });
});
