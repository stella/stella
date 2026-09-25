import { describe, expect, test } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import { knowledgeKeys } from "@/lib/knowledge/queries";
import { catalogueKeys } from "@/lib/knowledge/queries/catalogue";

import { startSkillSeed } from "./skill-seed";

const ORGANIZATION_ID = "org-1";

type SeedResult = { seeded: boolean };

/** A seed endpoint the test settles by hand, counting how often it is hit. */
const createControlledSeed = () => {
  const settlers: ((result: SeedResult) => void)[] = [];
  const failers: ((error: Error) => void)[] = [];
  const seedSkills = () =>
    new Promise<SeedResult>((resolve, reject) => {
      settlers.push(resolve);
      failers.push(reject);
    });
  return {
    seedSkills,
    calls: () => settlers.length,
    settle: (result: SeedResult) => settlers.at(-1)?.(result),
    fail: () => failers.at(-1)?.(new Error("seed failed")),
  };
};

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const seedCachedQueries = (queryClient: QueryClient) => {
  queryClient.setQueryData(
    knowledgeKeys.skills.list(ORGANIZATION_ID, { limit: 50 }),
    [],
  );
  queryClient.setQueryData(catalogueKeys.list(ORGANIZATION_ID), []);
};

const isInvalidated = (queryClient: QueryClient, queryKey: readonly unknown[]) =>
  queryClient.getQueryState(queryKey)?.isInvalidated ?? false;

describe("skill seed on the Tools page", () => {
  test("starting the seed returns before the seed request settles", async () => {
    const queryClient = new QueryClient();
    const seed = createControlledSeed();

    const started = startSkillSeed({
      queryClient,
      organizationId: ORGANIZATION_ID,
      seedSkills: seed.seedSkills,
    });

    expect(started).toBeUndefined();
    await flush();
    expect(seed.calls()).toBe(1);
    seed.settle({ seeded: false });
  });

  test("seeds at most once per session for an organization", async () => {
    const queryClient = new QueryClient();
    const seed = createControlledSeed();
    const options = {
      queryClient,
      organizationId: ORGANIZATION_ID,
      seedSkills: seed.seedSkills,
    };

    startSkillSeed(options);
    await flush();
    seed.settle({ seeded: false });
    await flush();
    startSkillSeed(options);
    await flush();

    expect(seed.calls()).toBe(1);
  });

  test("a failed seed is tried again on the next visit", async () => {
    const queryClient = new QueryClient();
    const seed = createControlledSeed();
    const options = {
      queryClient,
      organizationId: ORGANIZATION_ID,
      seedSkills: seed.seedSkills,
    };

    startSkillSeed(options);
    await flush();
    seed.fail();
    await flush();
    startSkillSeed(options);
    await flush();

    expect(seed.calls()).toBe(2);
    seed.settle({ seeded: false });
  });

  test("new default skills refresh the cached skill and catalogue lists", async () => {
    const queryClient = new QueryClient();
    seedCachedQueries(queryClient);
    const seed = createControlledSeed();

    startSkillSeed({
      queryClient,
      organizationId: ORGANIZATION_ID,
      seedSkills: seed.seedSkills,
    });
    await flush();
    seed.settle({ seeded: true });
    await flush();

    expect(
      isInvalidated(
        queryClient,
        knowledgeKeys.skills.list(ORGANIZATION_ID, { limit: 50 }),
      ),
    ).toBe(true);
    expect(isInvalidated(queryClient, catalogueKeys.list(ORGANIZATION_ID))).toBe(
      true,
    );
  });

  test("a seed that wrote nothing leaves cached lists alone", async () => {
    const queryClient = new QueryClient();
    seedCachedQueries(queryClient);
    const seed = createControlledSeed();

    startSkillSeed({
      queryClient,
      organizationId: ORGANIZATION_ID,
      seedSkills: seed.seedSkills,
    });
    await flush();
    seed.settle({ seeded: false });
    await flush();

    expect(isInvalidated(queryClient, catalogueKeys.list(ORGANIZATION_ID))).toBe(
      false,
    );
  });
});
