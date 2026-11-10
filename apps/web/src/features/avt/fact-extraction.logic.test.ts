import { describe, expect, test } from "bun:test";

import type { ExtractionPhase } from "@/features/avt/fact-extraction.logic";
import {
  extractionPhase,
  isExtractionBusy,
  latestFactExtraction,
  settledOutcome,
  startRefusalKey,
} from "@/features/avt/fact-extraction.logic";
import type {
  GenerationRunErrorCode,
  GenerationRunSummary,
} from "@/features/avt/types";
import { EXTRACTION_ERROR_KEYS } from "@/features/avt/types";
import { toSafeId } from "@/lib/safe-id";

const runId = (id: string) => toSafeId<"legalListGenerationRun">(id);

const run = ({
  id,
  ...overrides
}: Partial<Omit<GenerationRunSummary, "id">> & {
  id: string;
}): GenerationRunSummary => ({
  id: runId(id),
  status: "queued",
  producer: "stella",
  itemType: "fact",
  errorCode: null,
  instruction: "List every fact the documents establish.",
  createdAt: "2026-11-10T09:00:00.000Z",
  updatedAt: "2026-11-10T09:00:00.000Z",
  startedAt: null,
  completedAt: null,
  ...overrides,
});

type RunStatus = GenerationRunSummary["status"];

const phaseOf = (status: RunStatus) =>
  extractionPhase(run({ id: "r", status })).type;

const busyOf = (status: RunStatus) =>
  isExtractionBusy(extractionPhase(run({ id: "r", status })));

const isErrorCode = (code: string): code is GenerationRunErrorCode =>
  Object.hasOwn(EXTRACTION_ERROR_KEYS, code);

describe("latestFactExtraction", () => {
  test("follows the newest run stella produced for facts, past newer external or task runs", () => {
    const runs = [
      run({ id: "external", producer: "external", itemType: null }),
      run({ id: "tasks", itemType: "task" }),
      run({ id: "facts-new", status: "review" }),
      run({ id: "facts-old", status: "committed" }),
    ];
    expect(latestFactExtraction(runs)?.id).toBe(runId("facts-new"));
  });

  test("is null when stella never extracted facts for the list", () => {
    expect(
      latestFactExtraction([run({ id: "external", producer: "external" })]),
    ).toBeNull();
  });
});

describe("extractionPhase", () => {
  test("every run status lands in exactly one phase", () => {
    expect({
      queued: phaseOf("queued"),
      running: phaseOf("running"),
      review: phaseOf("review"),
      committed: phaseOf("committed"),
      failed: phaseOf("failed"),
      cancelled: phaseOf("cancelled"),
    } satisfies Record<RunStatus, ExtractionPhase["type"]>).toEqual({
      queued: "queued",
      running: "running",
      review: "review",
      committed: "settled",
      failed: "failed",
      cancelled: "none",
    });
  });

  test("a failed run explains itself with its error code's message", () => {
    const codes = Object.keys(EXTRACTION_ERROR_KEYS).filter(isErrorCode);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const phase = extractionPhase(
        run({ id: "r", status: "failed", errorCode: code }),
      );
      expect(phase).toEqual({
        type: "failed",
        runId: "r",
        errorKey: EXTRACTION_ERROR_KEYS[code],
      });
    }
  });

  test("a failed run without a code still reads as a failure", () => {
    expect(
      extractionPhase(run({ id: "r", status: "failed", errorCode: null })),
    ).toEqual({
      type: "failed",
      runId: "r",
      errorKey: EXTRACTION_ERROR_KEYS.internal,
    });
  });

  test("only an unfinished or unreviewed run holds off the next one", () => {
    expect({
      queued: busyOf("queued"),
      running: busyOf("running"),
      review: busyOf("review"),
      committed: busyOf("committed"),
      failed: busyOf("failed"),
      cancelled: busyOf("cancelled"),
    } satisfies Record<RunStatus, boolean>).toEqual({
      queued: true,
      running: true,
      review: true,
      committed: false,
      failed: false,
      cancelled: false,
    });
    expect(isExtractionBusy(extractionPhase(null))).toBe(false);
  });
});

describe("settledOutcome", () => {
  test("a run that proposed nothing says it found nothing", () => {
    expect(settledOutcome([])).toEqual({ type: "nothingFound" });
  });

  test("a reviewed run counts what was kept against what was proposed", () => {
    expect(
      settledOutcome([
        { status: "accepted" },
        { status: "rejected" },
        { status: "accepted" },
      ]),
    ).toEqual({ type: "reviewed", proposed: 3, accepted: 2 });
  });
});

describe("startRefusalKey", () => {
  test("names the fix for refusals a reviewer can act on", () => {
    expect(startRefusalKey("document_encrypted")).toBe(
      "errors.apiCodes.encryptedContent",
    );
    expect(startRefusalKey("document_format_unsupported")).toBe(
      "avt.extraction.errors.unsupportedFormat",
    );
    expect(startRefusalKey("list_or_document_not_found")).toBe(
      "avt.extraction.errors.documentMissing",
    );
  });

  test("leaves any other refusal to the generic message", () => {
    expect(startRefusalKey(undefined)).toBeNull();
    expect(startRefusalKey("usage_limit_exceeded")).toBeNull();
    expect(startRefusalKey("toString")).toBeNull();
  });
});
