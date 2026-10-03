import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { envBaseServerSchema } from "@/api/env-base-schema";
import {
  API_RATE_LIMITS,
  getPublicCorpusLimits,
  type PublicCorpusLimitsConfiguration,
} from "@/api/lib/limits";

const configurationSchema = v.object({
  PUBLIC_LAW_DATABASE_POOL_MAX:
    envBaseServerSchema.PUBLIC_LAW_DATABASE_POOL_MAX,
  PUBLIC_CORPUS_ASSUMED_REPLICAS:
    envBaseServerSchema.PUBLIC_CORPUS_ASSUMED_REPLICAS,
  PUBLIC_CORPUS_SEARCH_P95_SECONDS:
    envBaseServerSchema.PUBLIC_CORPUS_SEARCH_P95_SECONDS,
  PUBLIC_CORPUS_AGGREGATE_P95_SECONDS:
    envBaseServerSchema.PUBLIC_CORPUS_AGGREGATE_P95_SECONDS,
  PUBLIC_CORPUS_SITEMAP_P95_SECONDS:
    envBaseServerSchema.PUBLIC_CORPUS_SITEMAP_P95_SECONDS,
  PUBLIC_CORPUS_SEARCH_ADDRESS_MAX:
    envBaseServerSchema.PUBLIC_CORPUS_SEARCH_ADDRESS_MAX,
  PUBLIC_CORPUS_SEARCH_GLOBAL_MAX:
    envBaseServerSchema.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX,
  PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX:
    envBaseServerSchema.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX,
  PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX:
    envBaseServerSchema.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX,
});

const defaults = () =>
  ({
    ...v.parse(configurationSchema, {}),
    PUBLIC_CORPUS_SEARCH_ADDRESS_MAX: undefined,
    PUBLIC_CORPUS_SEARCH_GLOBAL_MAX: undefined,
    PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX: undefined,
    PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX: undefined,
  }) satisfies PublicCorpusLimitsConfiguration;

describe("public corpus capacity configuration", () => {
  test("defaults derive fleet ceilings from public database pool and p95 estimates", () => {
    const configuration = defaults();
    expect(configuration).toMatchObject({
      PUBLIC_LAW_DATABASE_POOL_MAX: 2,
      PUBLIC_CORPUS_ASSUMED_REPLICAS: 2,
      PUBLIC_CORPUS_SEARCH_P95_SECONDS: 1,
      PUBLIC_CORPUS_AGGREGATE_P95_SECONDS: 2,
      PUBLIC_CORPUS_SITEMAP_P95_SECONDS: 30,
    });
    expect(getPublicCorpusLimits(configuration)).toEqual({
      totalConcurrency: 6,
      classes: {
        search: {
          concurrency: 4,
          address: { duration: 60_000, max: 30 },
          global: { duration: 60_000, max: 480, localMax: 240 },
        },
        aggregate: {
          concurrency: 2,
          address: { duration: 60_000, max: 60 },
          global: { duration: 60_000, max: 120, localMax: 60 },
        },
        sitemap: {
          address: { duration: 60_000, max: 10 },
          global: { duration: 60_000, max: 24, localMax: 12 },
        },
        browse: { address: API_RATE_LIMITS.api },
      },
    });
  });

  test("custom pool, replicas and latency independently scale request budgets", () => {
    const limits = getPublicCorpusLimits({
      ...defaults(),
      PUBLIC_LAW_DATABASE_POOL_MAX: 5,
      PUBLIC_CORPUS_ASSUMED_REPLICAS: 3,
      PUBLIC_CORPUS_SEARCH_P95_SECONDS: 4,
      PUBLIC_CORPUS_AGGREGATE_P95_SECONDS: 7,
      PUBLIC_CORPUS_SITEMAP_P95_SECONDS: 11,
    });
    expect(limits.totalConcurrency).toBe(15);
    expect(limits.classes.search).toEqual({
      concurrency: 10,
      address: { duration: 60_000, max: 30 },
      global: { duration: 60_000, max: 450, localMax: 150 },
    });
    expect(limits.classes.aggregate.global).toEqual({
      duration: 60_000,
      max: 128,
      localMax: 42,
    });
    expect(limits.classes.sitemap.global).toEqual({
      duration: 60_000,
      max: 245,
      localMax: 81,
    });
  });

  test("operator overrides replace derived budgets without exceeding the fleet ceiling on fallback", () => {
    const limits = getPublicCorpusLimits({
      ...defaults(),
      PUBLIC_CORPUS_ASSUMED_REPLICAS: 4,
      PUBLIC_CORPUS_SEARCH_ADDRESS_MAX: 17,
      PUBLIC_CORPUS_SEARCH_GLOBAL_MAX: 31,
      PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX: 7,
      PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX: 3,
    });
    expect(limits.classes.search.address).toEqual({
      duration: 60_000,
      max: 17,
    });
    expect(limits.classes.search.global).toEqual({
      duration: 60_000,
      max: 31,
      localMax: 7,
    });
    expect(limits.classes.aggregate.global).toEqual({
      duration: 60_000,
      max: 7,
      localMax: 1,
    });
    expect(limits.classes.sitemap.global).toEqual({
      duration: 60_000,
      max: 3,
      localMax: 0,
    });
  });

  test("very slow requests retain a positive fleet budget and can disable replica fallback", () => {
    const limits = getPublicCorpusLimits({
      ...defaults(),
      PUBLIC_CORPUS_SEARCH_P95_SECONDS: 100_000,
      PUBLIC_CORPUS_AGGREGATE_P95_SECONDS: 100_000,
      PUBLIC_CORPUS_SITEMAP_P95_SECONDS: 100_000,
    });
    for (const global of [
      limits.classes.search.global,
      limits.classes.aggregate.global,
      limits.classes.sitemap.global,
    ]) {
      expect(global).toEqual({ duration: 60_000, max: 1, localMax: 0 });
    }
  });

  test("configuration accepts positive integers and rejects zero, signed, fractional and nonnumeric values", () => {
    const keys = Object.keys(configurationSchema.entries);
    for (const key of keys) {
      expect(
        v.safeParse(configurationSchema, { [key]: "13" }).success,
        key,
      ).toBe(true);
      for (const value of [
        "0",
        "-1",
        "1.5",
        "NaN",
        "Infinity",
        "",
        " ",
        "1e3",
      ]) {
        expect(
          v.safeParse(configurationSchema, { [key]: value }).success,
          `${key}=${value}`,
        ).toBe(false);
      }
    }
  });
});
