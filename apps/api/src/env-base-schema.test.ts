import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  envBaseInvariantViolation,
  envBaseServerSchema,
} from "@/api/env-base-schema";
import { QUERY_EXPANSION_MODES } from "@/api/lib/legal-search/query-expansion-mode";

const deployedCorpusEnvironment = {
  CORPUS_INDEX_Q09_ENDPOINT:
    "http://corpus-index-v09.stella-staging.local:7280",
  CORPUS_STORAGE_ENABLED: true,
  DATABASE_URL: "postgres://stella@database.internal/stella?sslmode=require",
  LEGAL_CORPUS_S3_BUCKET: "stella-staging-legal-corpus",
  LEGAL_SEARCH_PROVIDER: "corpus-index",
  S3_CREDENTIALS_PROVIDER: "aws-runtime",
  S3_ENDPOINT: "https://s3.eu-central-1.amazonaws.com",
  isDev: false,
} as const;

describe("corpus cluster endpoint transport", () => {
  test("canonical storage can delegate projection to another worker", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_PROJECTION_OWNER: "external",
        CORPUS_STORAGE_MODE: "canonical",
      }),
    ).toBeNull();
  });

  test("canonical storage rejects an unowned projection", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_STORAGE_MODE: "canonical",
      }),
    ).toContain("requires CORPUS_PROJECTION_OWNER");
  });

  test("the corpus-index provider needs an endpoint to read from", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_ENDPOINT: undefined,
      }),
    ).toBe(
      "LEGAL_SEARCH_PROVIDER=corpus-index requires CORPUS_INDEX_Q09_SEARCH_ENDPOINT or CORPUS_INDEX_Q09_ENDPOINT.",
    );
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

  test("accepts a lane-suffixed q09 mutation endpoint", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_ENDPOINT:
          "http://corpus-index-v09-append.stella-staging.local:7280",
      }),
    ).toBeNull();
  });

  test("rejects a q09 mutation endpoint under another service name", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_ENDPOINT:
          "http://corpus-index-v10.stella-staging.local:7280",
      }),
    ).toBe(
      "CORPUS_INDEX_Q09_ENDPOINT must use HTTPS unless it targets loopback or the private corpus-index-v09 Cloud Map service.",
    );
  });

  test("accepts a private-host q09 search endpoint outside local development", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_SEARCH_ENDPOINT:
          "http://corpus-index-v09-search.stella-staging.local:7280",
      }),
    ).toBeNull();
  });

  test("rejects a private search host on a non-HTTP scheme", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_SEARCH_ENDPOINT:
          "ftp://corpus-index-v09-search.stella-staging.local:7280",
      }),
    ).toBe(
      "CORPUS_INDEX_Q09_SEARCH_ENDPOINT must use HTTPS unless it targets a loopback address or the private corpus-index-v09 Cloud Map service.",
    );
  });

  test("rejects a private search host carrying credentials", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_SEARCH_ENDPOINT:
          "http://user:pw@corpus-index-v09-search.stella-staging.local:7280",
      }),
    ).toBe(
      "CORPUS_INDEX_Q09_SEARCH_ENDPOINT must use HTTPS unless it targets a loopback address or the private corpus-index-v09 Cloud Map service.",
    );
  });

  test("rejects a private mutation host carrying credentials", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_ENDPOINT:
          "http://user:pw@corpus-index-v09.stella-staging.local:7280",
      }),
    ).toBe(
      "CORPUS_INDEX_Q09_ENDPOINT must use HTTPS unless it targets loopback or the private corpus-index-v09 Cloud Map service.",
    );
  });

  test("keeps a remote plaintext search override forbidden", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_SEARCH_ENDPOINT: "http://search.example.com",
      }),
    ).toBe(
      "CORPUS_INDEX_Q09_SEARCH_ENDPOINT must use HTTPS unless it targets a loopback address or the private corpus-index-v09 Cloud Map service.",
    );
  });

  test("keeps a public search endpoint forbidden outside local development", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_INDEX_Q09_SEARCH_ENDPOINT: "https://search.example.com",
      }),
    ).toBe(
      "CORPUS_INDEX_Q09_SEARCH_ENDPOINT is only supported in local development or against the private corpus-index-v09 Cloud Map service.",
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

describe("redis transport", () => {
  test("a process without REDIS_URL passes the base invariant", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_STORAGE_MODE: "canonical",
        CORPUS_PROJECTION_OWNER: "external",
      }),
    ).toBeNull();
  });

  test("rejects a plaintext Redis endpoint outside local development", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_STORAGE_MODE: "canonical",
        CORPUS_PROJECTION_OWNER: "external",
        REDIS_URL: "redis://cache.internal:6379",
      }),
    ).toBe(
      "REDIS_URL must use rediss:// unless it targets loopback or Railway private networking.",
    );
  });

  test("accepts a TLS Redis endpoint outside local development", () => {
    expect(
      envBaseInvariantViolation({
        ...deployedCorpusEnvironment,
        CORPUS_STORAGE_MODE: "canonical",
        CORPUS_PROJECTION_OWNER: "external",
        REDIS_URL: "rediss://cache.internal:6380",
      }),
    ).toBeNull();
  });
});
