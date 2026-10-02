import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { CHAT_TRANSPORT_ERROR_CODE } from "@stll/anonymize-chat";

import { refuseAnonymizedCrossing } from "@/api/handlers/chat/anonymization-refusal";
import {
  ANONYMIZATION_REFUSAL_SITES,
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";

// Every refusal to cross the anonymized boundary is counted, so a refusal
// that starts failing anonymized turns in production cannot stay silent.
// Counting rides on construction: the guard below holds that each refusal in
// the API is built by `refuseAnonymizedCrossing` (or, at MCP egress, counted
// by the wrapped anonymizer), and that every declared site is one some code
// actually counts at.

const API_SRC = path.resolve(import.meta.dir, "../..");
const REFUSAL_MODULE = "handlers/chat/anonymization-refusal.ts";
const METRICS_MODULE = "lib/observability/request-metrics.ts";
const REFUSAL_CODE_REFERENCE =
  "CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal";

/** The API's production sources, by path relative to `src`. */
const productionSources = async (): Promise<Map<string, string>> => {
  const sources = new Map<string, string>();
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: API_SRC })) {
    if (file.endsWith(".test.ts") || file.startsWith("tests/")) {
      continue;
    }
    sources.set(file, await Bun.file(path.join(API_SRC, file)).text());
  }
  return sources;
};

const SITE_LITERAL = /\bsite: "(?<site>[a-z_]+)"/gu;

afterEach(() => {
  resetMetricLineSinkForTesting();
});

describe("anonymized boundary refusals", () => {
  test("are built only by the counting constructor", async () => {
    const sources = await productionSources();
    const buildersOfTheRefusalCode = [...sources]
      .filter(([, text]) => text.includes(REFUSAL_CODE_REFERENCE))
      .map(([file]) => file);
    expect(buildersOfTheRefusalCode).toEqual([REFUSAL_MODULE]);

    // Every error the boundary module builds is a refusal.
    const boundary =
      sources.get("handlers/chat/third-party-boundary.ts") ??
      expect.unreachable("The boundary module moved");
    expect(boundary).not.toContain("new HandlerError(");
  });

  test("are counted at every declared site, and only at declared sites", async () => {
    const sources = await productionSources();
    const counted = new Set<string>();
    for (const [file, text] of sources) {
      if (
        file === REFUSAL_MODULE ||
        file === METRICS_MODULE ||
        !(
          text.includes("refuseAnonymizedCrossing(") ||
          text.includes("emitAnonymizationRefusalMetric(")
        )
      ) {
        continue;
      }
      for (const match of text.matchAll(SITE_LITERAL)) {
        counted.add(match.groups?.["site"] ?? "");
      }
    }
    expect([...counted].toSorted()).toEqual(
      [...ANONYMIZATION_REFUSAL_SITES].toSorted(),
    );
  });

  test("count once as they are built, offering a raw retry only when asked", () => {
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });

    const retryable = refuseAnonymizedCrossing({
      message: "Cannot send this attachment.",
      offerRawRetry: true,
      reason: "unsupported_content",
      site: "attachment",
      status: 422,
    });
    const terminal = refuseAnonymizedCrossing({
      cause: new Error("anonymizer unavailable"),
      message: "Failed to anonymize.",
      offerRawRetry: false,
      reason: "pipeline_error",
      site: "text_batch",
      status: 500,
    });

    expect(retryable.code).toBe(
      CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
    );
    expect(retryable.status).toBe(422);
    expect(retryable.failureCode).toBe("boundary-refusal");
    expect(terminal.code).toBeUndefined();
    expect(terminal.status).toBe(500);
    expect(terminal.failureCode).toBe("boundary-refusal");
    expect(terminal.cause).toBeInstanceOf(Error);
    expect(lines.map((line): unknown => JSON.parse(line))).toEqual([
      expect.objectContaining({
        AnonymizationRefusals: 1,
        reason: "unsupported_content",
        site: "attachment",
      }),
      expect.objectContaining({
        AnonymizationRefusals: 1,
        reason: "pipeline_error",
        site: "text_batch",
      }),
    ]);
  });
});
