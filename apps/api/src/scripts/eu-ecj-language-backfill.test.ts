import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  PROCESS_DECISION_RETRY_REASON,
  PROCESS_DECISION_STATUS,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import {
  STORED_CORPUS_VALIDATION_CODE,
  StoredCorpusValidationError,
} from "@/api/lib/errors/tagged-errors";

import { classifyVariantWrite } from "./eu-ecj-language-backfill";

test("a typed write rejection remains retryable without exposing its diagnostics", () => {
  const rejected = Result.err(
    new StoredCorpusValidationError({
      message: "Stored AST unavailable",
      code: STORED_CORPUS_VALIDATION_CODE,
      paths: ["blocks.0.type"],
    }),
  );
  expect(classifyVariantWrite(rejected)).toEqual({
    type: "retryable",
    reason: "StoredCorpusValidationError",
  });
});

test.each(Object.values(PROCESS_DECISION_RETRY_REASON))(
  "a successful pipeline result preserves retry reason %s",
  (reason) => {
    expect(
      classifyVariantWrite(
        Result.ok({
          status: PROCESS_DECISION_STATUS.RETRYABLE,
          inserted: false,
          reason,
        }),
      ),
    ).toEqual({ type: "retryable", reason });
  },
);

test.each([true, false])(
  "a completed pipeline result with inserted=%s is written",
  (inserted) => {
    expect(
      classifyVariantWrite(
        Result.ok({
          status: PROCESS_DECISION_STATUS.COMPLETE,
          inserted,
          searchVectorFailed: false,
        }),
      ),
    ).toEqual({ type: "written" });
  },
);
