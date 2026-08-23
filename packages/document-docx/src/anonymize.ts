import { CALLER_DETECTION_MAX_COUNT } from "@stll/anonymize";

import { docxWorkflowCoverage } from "./coverage";
import { extractDocxText } from "./extract";
import { docxLocationKey, docxLocationsEqual } from "./location";
import { rewriteDocxText } from "./rewrite";
import {
  DOCX_ANONYMIZATION_ERROR_CODES,
  DOCX_COVERAGE_MODES,
  type AnonymizeDocxOptions,
  type DocxAnonymizationErrorCode,
  type DocxAnonymizationResult,
  type DocxBlockCallerDetections,
  type DocxBlockRewrite,
} from "./types";

export const DOCX_ANONYMIZATION_MAX_CALLER_DETECTIONS =
  CALLER_DETECTION_MAX_COUNT;

export class DocxAnonymizationError extends Error {
  readonly code: DocxAnonymizationErrorCode;

  constructor(code: DocxAnonymizationErrorCode, message: string) {
    super(message);
    this.name = "DocxAnonymizationError";
    this.code = code;
  }
}

const anonymizationError = (
  code: DocxAnonymizationErrorCode,
  message: string,
): DocxAnonymizationError => new DocxAnonymizationError(code, message);

type DetectionPlan = {
  detectionsByLocation: ReadonlyMap<string, DocxBlockCallerDetections>;
  callerDetectionCount: number;
};

const planCallerDetections = (
  extractionBlocks: ReturnType<typeof extractDocxText>["blocks"],
  inputs: readonly DocxBlockCallerDetections[],
): DetectionPlan => {
  const blocksByLocation = new Map(
    extractionBlocks.map((block) => [docxLocationKey(block.location), block]),
  );
  const detectionsByLocation = new Map<string, DocxBlockCallerDetections>();
  let callerDetectionCount = 0;
  for (const input of inputs) {
    const key = docxLocationKey(input.location);
    if (detectionsByLocation.has(key)) {
      throw anonymizationError(
        DOCX_ANONYMIZATION_ERROR_CODES.invalidCallerDetections,
        "Each DOCX block may have only one caller-detection input",
      );
    }
    const block = blocksByLocation.get(key);
    if (
      block === undefined ||
      !docxLocationsEqual(block.location, input.location) ||
      block.text !== input.expectedText
    ) {
      throw anonymizationError(
        DOCX_ANONYMIZATION_ERROR_CODES.invalidCallerDetections,
        "DOCX caller-detection location or expected text no longer matches",
      );
    }
    if (
      input.detections.length >
      DOCX_ANONYMIZATION_MAX_CALLER_DETECTIONS - callerDetectionCount
    ) {
      throw anonymizationError(
        DOCX_ANONYMIZATION_ERROR_CODES.invalidCallerDetections,
        `DOCX workflows must not contain more than ${DOCX_ANONYMIZATION_MAX_CALLER_DETECTIONS} caller detections`,
      );
    }
    detectionsByLocation.set(key, input);
    callerDetectionCount += input.detections.length;
  }
  return { detectionsByLocation, callerDetectionCount };
};

export const anonymizeDocx = ({
  document,
  session,
  expectedSessionId,
  policy,
  callerDetections = [],
  observedAtEpochSeconds,
}: AnonymizeDocxOptions): DocxAnonymizationResult => {
  const sessionId = session.sessionId();
  if (sessionId !== expectedSessionId) {
    throw anonymizationError(
      DOCX_ANONYMIZATION_ERROR_CODES.sessionMismatch,
      "DOCX anonymization session does not match the expected session",
    );
  }

  const extraction = extractDocxText(document);
  const coverage = docxWorkflowCoverage(extraction.coverage);
  if (
    coverage.status === "partial" &&
    policy.coverage.mode === DOCX_COVERAGE_MODES.requireFull
  ) {
    throw anonymizationError(
      DOCX_ANONYMIZATION_ERROR_CODES.incompleteCoverage,
      "DOCX contains content outside the fully supported anonymization coverage",
    );
  }

  const { detectionsByLocation, callerDetectionCount } = planCallerDetections(
    extraction.blocks,
    callerDetections,
  );
  const plan = session.planTextBatchWithCallerDetections({
    inputs: extraction.blocks.map((block) => ({
      fullText: block.text,
      detections:
        detectionsByLocation.get(docxLocationKey(block.location))?.detections ??
        [],
    })),
    ...(policy.operators === undefined ? {} : { operators: policy.operators }),
    ...(observedAtEpochSeconds === undefined ? {} : { observedAtEpochSeconds }),
  });
  if (plan.blocks.length !== extraction.blocks.length) {
    throw anonymizationError(
      DOCX_ANONYMIZATION_ERROR_CODES.invalidCallerDetections,
      "DOCX session redaction plan does not match the extracted block count",
    );
  }

  const rewrites: DocxBlockRewrite[] = [];
  let entityCount = 0;
  let retainedCallerDetectionCount = 0;
  for (const [index, block] of extraction.blocks.entries()) {
    const blockPlan = plan.blocks.at(index);
    if (blockPlan === undefined) {
      throw anonymizationError(
        DOCX_ANONYMIZATION_ERROR_CODES.invalidCallerDetections,
        "DOCX session redaction plan is missing an extracted block",
      );
    }
    entityCount += blockPlan.entityCount;
    retainedCallerDetectionCount += blockPlan.callerEntityCount;
    if (blockPlan.replacements.length === 0) {
      continue;
    }
    rewrites.push({
      location: block.location,
      expectedText: block.text,
      replacements: blockPlan.replacements,
    });
  }

  const rewritten = rewriteDocxText(document, rewrites);
  plan.commit();
  return {
    document: rewritten.document,
    summary: {
      contractVersion: 1,
      sessionId,
      blockCount: extraction.blocks.length,
      rewrittenBlockCount: rewritten.rewrittenBlockCount,
      appliedReplacementCount: rewritten.appliedReplacementCount,
      entityCount,
      callerDetectionCount,
      retainedCallerDetectionCount,
      coverage,
    },
  };
};
