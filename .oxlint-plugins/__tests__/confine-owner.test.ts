import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { OWNERSHIP } from "../../scripts/ownership.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

test("every admission-store consumer must use the checked facade", async () => {
  const admission = OWNERSHIP.find(({ id }) => id === "admission-redis");
  if (admission?.enforcement.kind !== "import") {
    throw new TypeError("Missing admission-store ownership");
  }
  const consumers = admission.enforcement.allowed;
  expect(consumers.length).toBeGreaterThan(0);
  for (const { path: sourcePath } of consumers) {
    const source = [
      'import { createRedisClient } from "@/api/lib/redis-client";',
      'const unchecked = await import("@/api/lib/redis-client");',
      'import { createAdmissionRedis } from "@/api/lib/admission-redis";',
    ].join("\n");
    expect(
      await lintSingleRule("confine-owner", source, {
        ruleOptions: { entries: OWNERSHIP },
        sourcePath,
      }),
    ).toEqual([1, 2]);
  }
});

// `member-call` rows are scoped by path, which the passive fixture under
// `.oxlint-plugins/__fixtures__` cannot sit inside, so they are exercised here
// with a source written beneath the scoped prefix.
const MEMBER_CALL_OPTIONS = {
  entries: [
    {
      id: "deterministic-job-requeue",
      owner: ["apps/api/src/lib/bullmq-requeue.ts"],
      enforcement: {
        kind: "member-call",
        method: "getState",
        within: ["apps/api/src/"],
        allowed: [{ path: "apps/api/src/lib/allowed.ts", reason: "test" }],
      },
    },
  ],
};

const SOURCE = [
  "const state = await job.getState();",
  "const optional = await job?.getState();",
  "const other = await job.getStatus();",
  "const read = job.getState;",
  "",
].join("\n");

const lint = async (sourcePath: string) =>
  await lintSingleRule("confine-owner", SOURCE, {
    ruleOptions: MEMBER_CALL_OPTIONS,
    sourcePath,
  });

test("provider receipt persistence remains confined to its owner", async () => {
  const entry = OWNERSHIP.find(({ id }) => id === "provider-event-records");
  expect(entry).toBeDefined();
  const source = 'import { hostedUsageWebhookEvents } from "@/api/db/schema";';
  const options = { ruleOptions: { entries: [entry] } };
  expect(
    await lintSingleRule("confine-owner", source, {
      ...options,
      sourcePath: "apps/api/src/lib/receipt-writer.ts",
    }),
  ).toEqual([1]);
  expect(
    await lintSingleRule("confine-owner", source, {
      ...options,
      sourcePath: "apps/api/src/lib/hosted-usage-provider/webhook-store.ts",
    }),
  ).toEqual([]);
});

describe.serial("confine-owner member-call rows", () => {
  test("reports a call of the method inside the scoped paths", async () => {
    expect(await lint("apps/api/src/lib/sweep.ts")).toEqual([1, 2]);
  });

  test("leaves the owner and its allowed files alone", async () => {
    expect(await lint("apps/api/src/lib/bullmq-requeue.ts")).toEqual([]);
    expect(await lint("apps/api/src/lib/allowed.ts")).toEqual([]);
  });

  test("leaves files outside the scoped paths alone", async () => {
    expect(await lint("apps/web/src/store.ts")).toEqual([]);
  });
});

describe.serial("member authority context ownership", () => {
  test("allows construction only in declared context builders", async () => {
    const source =
      'import { hasMemberPermission, sessionMemberRole } from "@/api/lib/permission-authorization";\nhasMemberPermission(sessionMemberRole("admin"), { entity: ["update"] });';
    const options = { ruleOptions: { entries: OWNERSHIP } };
    expect(
      await lintSingleRule("confine-owner", source, {
        ...options,
        sourcePath: "apps/api/src/handlers/example.ts",
      }),
    ).toEqual([1]);
    expect(
      await lintSingleRule("confine-owner", source, {
        ...options,
        sourcePath: "apps/api/src/lib/auth.ts",
      }),
    ).toEqual([]);
  });
});

describe.serial("legislation revision corpus ownership", () => {
  const entry = OWNERSHIP.find(
    ({ id }) => id === "legislation-revision-corpus-write",
  );
  const source = [
    'import { writeCorpusDocument as write } from "@/api/lib/legal-search/corpus-storage";',
    'import * as storage from "@/api/lib/legal-search/corpus-storage";',
    'export { writeCorpusDocument } from "@/api/lib/legal-search/corpus-storage";',
    'import { corpusMirrorColumns } from "@/api/lib/legal-search/corpus-storage";',
    "",
  ].join("\n");
  const lintRevisionWrite = async (sourcePath: string) =>
    await lintSingleRule("confine-owner", source, {
      ruleOptions: { entries: [entry] },
      sourcePath,
    });

  test("rejects writers and facades outside the revision owner", async () => {
    expect(entry).toBeDefined();
    expect(
      await lintRevisionWrite("apps/api/src/handlers/legislation/ingestion.ts"),
    ).toEqual([1, 2, 3]);
  });

  test("accepts the revision owner and shared corpus maintenance", async () => {
    expect(
      await lintRevisionWrite("apps/api/src/handlers/legislation/revision.ts"),
    ).toEqual([]);
    expect(
      await lintRevisionWrite(
        "apps/api/src/lib/legal-search/corpus-pack-batch.ts",
      ),
    ).toEqual([]);
  });
});

describe.serial("task assignment ownership", () => {
  const entry = OWNERSHIP.find(({ id }) => id === "task-assignment-membership");
  test("confines direct and aliased assignment primitives to their owners", async () => {
    expect(entry).toBeDefined();
    const source =
      'import { taskAssignees as assignments } from "@/api/db/schema";\nawait tx.insert(assignments).values({});\n';
    expect(
      await lintSingleRule("confine-owner", source, {
        ruleOptions: { entries: [entry] },
        sourcePath: "apps/api/src/handlers/tasks/new-writer.ts",
      }),
    ).toEqual([1]);
    expect(
      await lintSingleRule("confine-owner", source, {
        ruleOptions: { entries: [entry] },
        sourcePath: "apps/api/src/lib/tasks/assignment-membership.ts",
      }),
    ).toEqual([]);
  });
});
