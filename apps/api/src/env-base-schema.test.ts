import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  envBaseInvariantViolation,
  envBaseServerSchema,
} from "@/api/env-base-schema";
import { QUERY_EXPANSION_MODES } from "@/api/lib/legal-search/query-expansion-mode";

const deployedCorpusEnvironment = {
  CORPUS_INDEX_BACKPRESSURE_HIGH_WATERMARK: 80,
  CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK: 60,
  CORPUS_INDEX_ENDPOINT: "http://corpus-index.stella-staging.local:7280",
  CORPUS_INDEXING_ENABLED: true,
  CORPUS_STORAGE_ENABLED: true,
  DATABASE_URL: "postgres://stella@database.internal/stella?sslmode=require",
  LEGAL_CORPUS_S3_BUCKET: "stella-staging-legal-corpus",
  LEGAL_SEARCH_INDEX_GENERATION: "case_law_v2",
  LEGAL_SEARCH_PROVIDER: "corpus-index",
  S3_CREDENTIALS_PROVIDER: "aws-runtime",
  S3_ENDPOINT: "https://s3.eu-central-1.amazonaws.com",
  isDev: false,
} as const;

describe("corpus cluster endpoint transport", () => {
  test("canonical storage can delegate projection when the embedded writer is paused", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEXING_ENABLED: false,
        CORPUS_PROJECTION_OWNER: "external",
        CORPUS_STORAGE_MODE: "canonical",
      }),
    ).toBeNull();
  });

  test("canonical storage rejects an unowned projection", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEXING_ENABLED: false,
        CORPUS_STORAGE_MODE: "canonical",
      }),
    ).toContain("requires CORPUS_PROJECTION_OWNER");
  });

  test("accepts the VPC-only q09 mutation endpoint used by deployment", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_ENDPOINT:
          "http://corpus-index-v09.stella-staging.local:7280",
      }),
    ).toBeNull();
  });

  test("keeps a remote plaintext search override forbidden", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_SEARCH_ENDPOINT: "http://search.example.com",
      }),
    ).toBe(
      "CORPUS_INDEX_Q09_SEARCH_ENDPOINT must use HTTPS unless it targets a loopback address.",
    );
  });

  test("keeps a remote plaintext mutation endpoint forbidden", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_ENDPOINT: "http://quickwit-admin.example.com",
      }),
    ).toBe(
      "CORPUS_INDEX_Q09_ENDPOINT must use HTTPS unless it targets loopback or the private corpus-index-v09 Cloud Map service.",
    );
  });
});

describe("query expansion mode", () => {
  // Every mode is deployable. `on` was reserved by a boot refusal while a
  // corpus cursor could not say which dictionary built its page; the cursor
  // carries that now, so nothing is left to reserve.
  test.each([...QUERY_EXPANSION_MODES])("accepts %p", (mode) => {
    expect(v.parse(envBaseServerSchema.QUERY_EXPANSION_MODE, mode)).toBe(mode);
  });

  test("defaults to off", () => {
    expect(v.parse(envBaseServerSchema.QUERY_EXPANSION_MODE, undefined)).toBe(
      "off",
    );
  });

  test("rejects a mode outside the union", () => {
    expect(
      v.safeParse(envBaseServerSchema.QUERY_EXPANSION_MODE, "live").success,
    ).toBe(false);
  });
});
