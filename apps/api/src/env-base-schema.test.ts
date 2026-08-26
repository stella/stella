import { describe, expect, test } from "bun:test";

import { envBaseInvariantViolation } from "@/api/env-base-schema";

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
  QUERY_EXPANSION_MODE: "off",
  S3_CREDENTIALS_PROVIDER: "aws-runtime",
  S3_ENDPOINT: "https://s3.eu-central-1.amazonaws.com",
  isDev: false,
} as const;

describe("corpus cluster endpoint transport", () => {
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
