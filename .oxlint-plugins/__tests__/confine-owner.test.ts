import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { OWNERSHIP } from "../../scripts/ownership.ts";
import { lintRuleAcrossFiles, lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(30_000);

describe.serial("audit detail read ownership", () => {
  const entry = OWNERSHIP.find(({ id }) => id === "audit-detail-read");
  const readerPath = "apps/api/src/handlers/audit-logs/example.ts";
  const options = {
    ruleOptions: { entries: [entry] },
    sourcePath: readerPath,
    cwd: "scratch",
  } as const;

  test("confines persisted changes to the projection owner without production exceptions", () => {
    expect(entry?.owner).toEqual(["apps/api/src/lib/audit-log-details.ts"]);
    expect(entry?.enforcement).toEqual({
      kind: "table-column-read",
      specifiers: ["@/api/db/schema", "@/api/db/schema/contacts"],
      table: "auditLogs",
      columns: ["changes"],
      allowed: [],
    });
  });

  test("rejects column reads through canonical imports, computed access and local aliases", async () => {
    const sources = [
      'import { auditLogs as table } from "@/api/db/schema";',
      'import { auditLogs as table } from "@/api/db/schema/contacts.ts";',
      'import { auditLogs as table } from "../../db/schema.ts";',
      'import * as schema from "@/api/db/schema"; const { auditLogs: table } = schema;',
      'const { auditLogs: table } = await import("@/api/db/schema");',
    ];
    const reads = [
      "const direct = table.changes;",
      'const computed = table["changes"];',
      "const template = table[`changes`];",
      "const optional = table?.changes;",
      "const { changes: destructured } = table;",
      "const { id, ...rest } = table;",
      "const copy = table; const copiedChanges = copy.changes;",
      "const aliased = alias(table, 'entries'); const aliasedChanges = aliased.changes;",
      "const columns = getTableColumns(table);",
      "const spread = { ...table };",
      "const dynamic = table[key];",
      "({ changes: reassigned } = table);",
      "const safeId = table.id;",
      "const { resourceId } = table;",
    ];
    const results = await Promise.all(
      sources.map(async (lintCase, index) => {
        const source = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lintSingleRule(
            "confine-owner",
            [
              source,
              'import { alias } from "drizzle-orm/pg-core"; import { getTableColumns } from "drizzle-orm";',
              ...reads,
            ].join("\n"),
            options,
          ),
          expected: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
  });

  test("rejects implicit complete rows and admits selections of other columns", async () => {
    const source = [
      'import { auditLogs } from "@/api/db/schema";',
      "db.select().from(auditLogs);",
      "db.selectDistinct().from(auditLogs);",
      "db.selectDistinctOn([auditLogs.id]).from(auditLogs);",
      "db.insert(auditLogs).values({}).returning();",
      "db.update(auditLogs).set({}).returning();",
      "db.delete(auditLogs).returning();",
      "db.select().from(otherTable).leftJoin(auditLogs, condition);",
      "db.select().from(otherTable).innerJoin(auditLogs, condition);",
      "db.select({ id: auditLogs.id }).from(auditLogs);",
      "db.selectDistinct({ id: auditLogs.id }).from(auditLogs);",
      "db.selectDistinctOn([auditLogs.id], { id: auditLogs.id }).from(auditLogs);",
      "db.insert(auditLogs).values({}).returning({ id: auditLogs.id });",
      "db.select({ id: otherTable.id }).from(otherTable).leftJoin(auditLogs, condition);",
      "db.insert(auditLogs).values({ changes: payload });",
    ].join("\n");
    expect(await lintSingleRule("confine-owner", source, options)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  test("requires relational reads to exclude changes or select only other columns", async () => {
    const source = [
      "db.query.auditLogs.findMany();",
      "db.query.auditLogs.findFirst({ where });",
      "db.query.auditLogs.findMany({ columns: {} });",
      "db.query.auditLogs.findMany({ columns: { id: false } });",
      "db.query.auditLogs.findMany({ columns: { changes: true } });",
      "db.query.auditLogs.findMany({ columns: { ...columns, changes: false } });",
      "db.query.auditLogs.findMany({ columns: input });",
      "const all = db.query.auditLogs; all.findFirst();",
      "db['query']['auditLogs'].findMany();",
      "db.query.auditLogs.findMany({ columns: { changes: false }, ...input });",
      "db.query.auditLogs.findMany({ columns: { changes: false }, columns: { changes: true } });",
      "db.query.auditLogs.findMany({ columns: { id: true } });",
      "db.query.auditLogs.findFirst({ columns: { changes: false } });",
      "db.query.auditLogs.findMany({ columns: { id: true, changes: false } });",
      "const projection = { changes: false }; const opts = { columns: projection }; db.query.auditLogs.findMany(opts);",
      "db.query.otherTable.findMany();",
    ].join("\n");
    expect(await lintSingleRule("confine-owner", source, options)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  test("admits the owner and ignores unrelated bindings with the same names", async () => {
    const source = [
      'import { auditLogs } from "@/api/db/schema";',
      "const changes = auditLogs.changes;",
      "db.select().from(auditLogs);",
      "db.query.auditLogs.findMany();",
    ].join("\n");
    expect(
      await lintSingleRule("confine-owner", source, {
        ...options,
        sourcePath: "apps/api/src/lib/audit-log-details.ts",
      }),
    ).toEqual([]);
    expect(
      await lintSingleRule(
        "confine-owner",
        [
          'import { auditLogs } from "different-package";',
          "const changes = auditLogs.changes;",
          "db.select().from(auditLogs);",
          "const alias = (table) => table; const sameName = alias(auditLogs); sameName.changes;",
        ].join("\n"),
        options,
      ),
    ).toEqual([]);
    expect(
      await lintSingleRule(
        "confine-owner",
        [
          'import { auditLogs } from "@/api/db/schema";',
          "const read = (auditLogs) => auditLogs.changes;",
        ].join("\n"),
        options,
      ),
    ).toEqual([]);
  });

  test("the raw-read self-test reaches the column guard", async () => {
    const source = [
      'import { auditLogs } from "@/api/db/schema";',
      "db.select({ changes: auditLogs.changes }).from(auditLogs);",
    ].join("\n");
    expect(await lintSingleRule("confine-owner", source, options)).toEqual([2]);
    expect(
      await lintSingleRule("confine-owner", source, {
        ...options,
        ruleOptions: { entries: [] },
      }),
    ).toEqual([]);
  });
});

describe.serial("BullMQ worker ownership", () => {
  const entry = OWNERSHIP.find(({ id }) => id === "bullmq-worker");
  const source = [
    'import { Worker } from "bullmq";',
    'import { Worker as RawWorker } from "bullmq";',
    'import * as queues from "bullmq";',
    'import type { Worker as WorkerType } from "bullmq";',
    'export { Worker as ExportedWorker } from "bullmq";',
    'export * from "bullmq";',
    'const { Worker: DynamicWorker } = await import("bullmq");',
    'const dynamicNamespace = await import("bullmq");',
    'import { Queue, type Job } from "bullmq";',
    'const { Queue: DynamicQueue } = await import("bullmq");',
  ].join("\n");

  test("admits only the constructor owner and leaves other queue exports available", async () => {
    if (entry?.enforcement.kind !== "import") {
      throw new TypeError("BullMQ worker ownership must confine imports.");
    }
    expect(entry.owner).toEqual(["apps/api/src/lib/bullmq-queue.ts"]);
    expect(entry.enforcement).toEqual({
      kind: "import",
      specifiers: ["bullmq"],
      names: ["Worker"],
      allowed: [],
    });
    const options = { ruleOptions: { entries: [entry] } };
    expect(
      await lintSingleRule("confine-owner", source, {
        ...options,
        sourcePath: "apps/api/src/lib/example-worker.ts",
      }),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      await lintSingleRule("confine-owner", source, {
        ...options,
        sourcePath: "apps/api/src/lib/bullmq-queue.ts",
      }),
    ).toEqual([]);
  });
});

describe.serial("parallel dynamic import ownership", () => {
  const entry = OWNERSHIP.find(({ id }) => id === "bullmq-worker");
  const options = {
    ruleOptions: { entries: [entry] },
    sourcePath: "apps/api/src/lib/example-worker.ts",
  };

  test("tracks named bindings through each Promise.all slot", async () => {
    const sources = [
      'const [{ Queue }] = await Promise.all([import("bullmq")]);',
      'const [{ other }, { Queue: alias }] = await Promise.all([import("other"), import("bullmq")]);',
      'const [{ Worker }] = await Promise.all([import("bullmq")]);',
      'const [{ other }, { Worker: alias }] = await Promise.all([import("other"), import("bullmq")]);',
      'const [namespace] = await Promise.all([import("bullmq")]);',
      'const [{ Queue, ...rest }] = await Promise.all([import("bullmq")]);',
      'const [{ [key]: selected }] = await Promise.all([import("bullmq")]);',
      'const [{ Queue }] = await Promise.all([...others, import("bullmq")]);',
      'const [{ Queue }] = await Promise.all([import("bullmq"), ...others]);',
      'const [{ Queue }] = await Promise.allSettled([import("bullmq")]);',
      'const read = async (Promise) => { const [{ Queue }] = await Promise.all([import("bullmq")]); };',
      'const [slot] = Promise.all([import("bullmq")]);',
    ];
    expect(
      await lintSingleRule(
        "confine-owner",
        sources.map((source) => `{ ${source} }`).join("\n"),
        options,
      ),
    ).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe.serial("confine-owner literal patterns", () => {
  const entry = OWNERSHIP.find(({ id }) => id === "citation-graph-transaction");
  const source = [
    'const literal = "citation_resolution_walk";',
    "const template = sql`SELECT pg_advisory_xact_lock(hashtext('case_law'), hashtext('citation_resolution_walk'))`;",
    'const escaped = "citation\\x5fresolution_walk";',
    'const sibling = "different_graph";',
  ].join("\n");

  test("rejects direct and escaped keys in strings and SQL templates", async () => {
    expect(entry?.enforcement.kind).toBe("literal-pattern");
    expect(
      await lintSingleRule("confine-owner", source, {
        ruleOptions: { entries: [entry] },
        sourcePath: "apps/api/src/scripts/late-graph-writer.ts",
      }),
    ).toEqual([1, 2, 3]);
  });

  test("accepts the transaction owner and each explicit test exception", async () => {
    if (entry?.enforcement.kind !== "literal-pattern") {
      throw new TypeError("Missing citation graph transaction ownership");
    }
    const sourcePaths = [
      ...entry.owner,
      ...entry.enforcement.allowed.map(({ path: allowedPath }) => allowedPath),
    ];
    expect(
      await lintRuleAcrossFiles(
        "confine-owner",
        Object.fromEntries(
          sourcePaths.map((sourcePath) => [sourcePath, source]),
        ),
        { ruleOptions: { entries: [entry] } },
      ),
    ).toEqual(
      Object.fromEntries(sourcePaths.map((sourcePath) => [sourcePath, []])),
    );
  });

  test("per-file admission does not carry over to another writer", async () => {
    const options = { ruleOptions: { entries: [entry] } };
    expect(
      await lintSingleRule("confine-owner", source, {
        ...options,
        sourcePath:
          "apps/api/src/handlers/case-law/citation-graph-transaction.ts",
      }),
    ).toEqual([]);
    expect(
      await lintSingleRule("confine-owner", source, {
        ...options,
        sourcePath:
          "apps/api/src/handlers/case-law/citation-graph-transaction-copy.ts",
      }),
    ).toEqual([1, 2, 3]);
  });
});

test("every admission-store consumer must use the checked facade", async () => {
  const admission = OWNERSHIP.find(({ id }) => id === "admission-redis");
  if (admission?.enforcement.kind !== "import") {
    throw new TypeError("Missing admission-store ownership");
  }
  const consumers = admission.enforcement.allowed;
  expect(consumers.length).toBeGreaterThan(0);
  const source = [
    'import { createRedisClient } from "@/api/lib/redis-client";',
    'const unchecked = await import("@/api/lib/redis-client");',
    'import { createAdmissionRedis } from "@/api/lib/admission-redis";',
  ].join("\n");
  const files = Object.fromEntries(
    consumers.map(({ path: sourcePath }) => [sourcePath, source]),
  );
  expect(
    await lintRuleAcrossFiles("confine-owner", files, {
      ruleOptions: { entries: OWNERSHIP },
    }),
  ).toEqual(
    Object.fromEntries(
      consumers.map(({ path: sourcePath }) => [sourcePath, [1, 2]]),
    ),
  );
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

describe.serial("confine-owner function-call rows", () => {
  const source = [
    "const id = extractId(hit);",
    "const optional = extractId?.(hit);",
    "const wrapped = (extractId)(hit);",
    "const asserted = (extractId as (hit: unknown) => string)(hit);",
    "const other = extractSnippet(hit);",
    "const member = reader.extractId(hit);",
    "const reference = extractId;",
    "",
  ].join("\n");
  const options = {
    entries: [
      {
        id: "corpus-hit-classification",
        owner: ["apps/api/src/lib/legal-search/corpus-hit-disposition.ts"],
        enforcement: {
          kind: "function-call",
          name: "extractId",
          within: ["apps/api/src/lib/legal-search/", "apps/api/src/handlers/"],
          allowed: [
            { path: "apps/api/src/handlers/allowed.ts", reason: "test" },
          ],
        },
      },
    ],
  };
  const lintFunction = async (sourcePath: string) =>
    await lintSingleRule("confine-owner", source, {
      ruleOptions: options,
      sourcePath,
    });

  test("reports direct function calls in every scoped path and spelling", async () => {
    expect(await lintFunction("apps/api/src/lib/legal-search/scan.ts")).toEqual(
      [1, 2, 3, 4],
    );
    expect(await lintFunction("apps/api/src/handlers/search.ts")).toEqual([
      1, 2, 3, 4,
    ]);
  });

  test("leaves the function owner and allowed files alone", async () => {
    expect(
      await lintFunction(
        "apps/api/src/lib/legal-search/corpus-hit-disposition.ts",
      ),
    ).toEqual([]);
    expect(await lintFunction("apps/api/src/handlers/allowed.ts")).toEqual([]);
  });

  test("leaves function calls outside the declared scope alone", async () => {
    expect(await lintFunction("apps/api/src/lib/unrelated.ts")).toEqual([]);
    expect(await lintFunction("apps/web/src/search.ts")).toEqual([]);
  });
});

describe.serial("corpus hit ownership rows", () => {
  const source = [
    "extractId(hit);",
    'import { candidateDecisionRowsStatement } from "@/api/handlers/case-law/decisions/search";',
    'import { rehydrateCorpusIndexProviderCandidatesStatement } from "@/api/lib/legal-search/corpus-index-provider";',
    'import { pageDecisionRowsStatement } from "@/api/handlers/case-law/decisions/search";',
    "",
  ].join("\n");
  const ruleOptions = { entries: OWNERSHIP };

  test("rejects direct extraction and raw candidate readers outside their owners", async () => {
    const sourcePaths = [
      "apps/api/src/lib/legal-search/new-scan.ts",
      "apps/api/src/handlers/new-search.ts",
    ];
    expect(
      await lintRuleAcrossFiles(
        "confine-owner",
        Object.fromEntries(
          sourcePaths.map((sourcePath) => [sourcePath, source]),
        ),
        { ruleOptions },
      ),
    ).toEqual(
      Object.fromEntries(
        sourcePaths.map((sourcePath) => [sourcePath, [1, 2, 3, 4]]),
      ),
    );
  });

  test("accepts the hit classifier and the candidate query owners", async () => {
    expect(
      await lintSingleRule("confine-owner", "extractId(hit);", {
        ruleOptions,
        sourcePath: "apps/api/src/lib/legal-search/corpus-hit-disposition.ts",
      }),
    ).toEqual([]);
    const sourcePaths = [
      "apps/api/src/handlers/case-law/decisions/search.ts",
      "apps/api/src/lib/legal-search/corpus-index-provider.ts",
      "apps/api/src/lib/legal-search/corpus-rehydration-disposition.ts",
      "apps/api/src/handlers/case-law/decisions/search-hydration.db.test.ts",
    ];
    const ownerSource = source.split("\n").slice(1).join("\n");
    expect(
      await lintRuleAcrossFiles(
        "confine-owner",
        Object.fromEntries(
          sourcePaths.map((sourcePath) => [sourcePath, ownerSource]),
        ),
        { ruleOptions },
      ),
    ).toEqual(
      Object.fromEntries(sourcePaths.map((sourcePath) => [sourcePath, []])),
    );
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

const storedContentEntries = OWNERSHIP.filter(({ id }) =>
  [
    "stored-file-read",
    "stored-tenant-file-read",
    "audited-download-grant",
    "content-delivery-intent",
    "content-delivery-receipt",
    "content-delivery-scope",
  ].includes(id),
);

describe.serial("confine-owner stored content rows", () => {
  test("covers each stored content owner", () => {
    expect(storedContentEntries.map(({ id }) => id).toSorted()).toEqual(
      [
        "stored-file-read",
        "stored-tenant-file-read",
        "audited-download-grant",
        "content-delivery-intent",
        "content-delivery-receipt",
        "content-delivery-scope",
      ].toSorted(),
    );
  });

  for (const entry of storedContentEntries) {
    test(`${entry.id} confines each binding through static and dynamic module access`, async () => {
      if (entry.enforcement.kind !== "import") {
        throw new TypeError("Stored content ownership must confine imports.");
      }
      const module = entry.enforcement.specifiers.at(0);
      const names: readonly string[] | undefined =
        "names" in entry.enforcement ? entry.enforcement.names : undefined;
      const ownerPath = entry.owner.at(0);
      if (
        module === undefined ||
        names === undefined ||
        names.length === 0 ||
        ownerPath === undefined
      ) {
        throw new TypeError(
          "Stored content ownership must name a module, bindings, and owner.",
        );
      }
      const sources = [
        `import * as owned from "${module}";`,
        `export * from "${module}";`,
        `const module = await import("${module}");`,
      ];
      for (const name of names) {
        sources.push(
          `import { ${name} as import_${name} } from "${module}";`,
          `export { ${name} as export_${name} } from "${module}";`,
          `const { ${name}: destructured_${name} } = await import("${module}");`,
          `const member_${name} = (await import("${module}")).${name};`,
        );
      }
      const source = sources.join("\n");
      const ruleOptions = { entries: [entry] };
      expect(
        await lintSingleRule("confine-owner", source, { ruleOptions }),
      ).toEqual(sources.map((_, index) => index + 1));
      expect(
        await lintSingleRule("confine-owner", source, {
          ruleOptions,
          sourcePath: ownerPath,
        }),
      ).toEqual([]);
    });
  }
});

test("translation availability is consumed by the dialog owner", async () => {
  const source =
    'import { deepLAvailabilityOptions, deepLConfigOptions } from "@/lib/deepl/queries";';
  const sourcePaths = [
    "apps/web/src/components/translate-document-dialog.tsx",
    "apps/web/src/components/workspaces/row-actions.tsx",
    "apps/web/src/components/other-dialog.tsx",
  ];
  expect(
    await lintRuleAcrossFiles(
      "confine-owner",
      Object.fromEntries(sourcePaths.map((sourcePath) => [sourcePath, source])),
      {
        ruleOptions: {
          entries: OWNERSHIP.filter(({ id }) => id === "deepl-availability"),
        },
      },
    ),
  ).toEqual(
    Object.fromEntries(
      sourcePaths.map((sourcePath) => [
        sourcePath,
        sourcePath.endsWith("/translate-document-dialog.tsx") ? [] : [1],
      ]),
    ),
  );
});

test("desktop observations are confined to service and membership cleanup", async () => {
  const entry = OWNERSHIP.find(
    ({ id }) => id === "desktop-presence-observations",
  );
  if (entry?.enforcement.kind !== "import") {
    throw new TypeError("Missing desktop presence ownership");
  }
  const source = 'import { desktopPresence } from "@/api/db/schema";';
  const sourcePaths = [
    "apps/api/src/handlers/desktop-presence/other.ts",
    ...entry.owner,
    ...entry.enforcement.allowed.map(({ path: allowedPath }) => allowedPath),
  ];
  expect(
    await lintRuleAcrossFiles(
      "confine-owner",
      Object.fromEntries(sourcePaths.map((sourcePath) => [sourcePath, source])),
      { ruleOptions: { entries: [entry] } },
    ),
  ).toEqual(
    Object.fromEntries(
      sourcePaths.map((sourcePath, index) => [
        sourcePath,
        index === 0 ? [1] : [],
      ]),
    ),
  );
});

describe.serial("transaction proof ownership", () => {
  test("confines minting even inside another proofs directory", async () => {
    const entry = OWNERSHIP.find(
      ({ id }) => id === "transaction-proof-minting",
    );
    if (entry?.enforcement.kind !== "import") {
      throw new TypeError("Transaction proof minting must confine imports");
    }
    const source = [
      'import { defineProof as mint } from "@gdp-ts/core"; const second = mint("Second");',
      'import * as core from "@gdp-ts/core"; const third = core.defineProof("Third");',
      'export { defineProof } from "@gdp-ts/core";',
      'export * from "@gdp-ts/core";',
      'const { defineProof } = await import("@gdp-ts/core");',
      'import { name, type Named, type Proof } from "@gdp-ts/core";',
    ].join("\n");
    const rejectedPaths = [
      "apps/api/src/lib/signals/proofs/second-mint.ts",
      "apps/api/src/lib/proofs/second-mint.ts",
      "apps/api/src/handlers/signals/unchecked.ts",
    ];
    const sourcePaths = [...rejectedPaths, ...entry.owner];
    expect(
      await lintRuleAcrossFiles(
        "confine-owner",
        Object.fromEntries(
          sourcePaths.map((sourcePath) => [sourcePath, source]),
        ),
        { ruleOptions: { entries: [entry] } },
      ),
    ).toEqual(
      Object.fromEntries(
        sourcePaths.map((sourcePath) => [
          sourcePath,
          rejectedPaths.includes(sourcePath) ? [1, 2, 3, 4, 5] : [],
        ]),
      ),
    );
  });

  test("only predicate owners can invoke the checking boundary", async () => {
    const entry = OWNERSHIP.find(
      ({ id }) => id === "transaction-proof-predicates",
    );
    if (entry?.enforcement.kind !== "import") {
      throw new TypeError("Transaction proof predicates must confine imports");
    }
    const source = [
      'import { withCheckedTransaction as mint } from "@/api/lib/proofs/checked-transaction";',
      'export { withCheckedTransaction } from "@/api/lib/proofs/checked-transaction";',
      'import type { TransactionProof } from "@/api/lib/proofs/checked-transaction";',
    ].join("\n");
    const rejectedPath = "apps/api/src/handlers/signals/unchecked.ts";
    const sourcePaths = [rejectedPath, ...entry.owner];
    expect(
      await lintRuleAcrossFiles(
        "confine-owner",
        Object.fromEntries(
          sourcePaths.map((sourcePath) => [sourcePath, source]),
        ),
        { ruleOptions: { entries: [entry] } },
      ),
    ).toEqual(
      Object.fromEntries(
        sourcePaths.map((sourcePath) => [
          sourcePath,
          sourcePath === rejectedPath ? [1, 2] : [],
        ]),
      ),
    );
  });
});

describe.serial("checked operation ownership", () => {
  for (const id of [
    "operation-proof-predicates",
    "conditional-operation-predicates",
    "checked-operation-execution",
    "file-reservation-evidence",
    "file-reservation-checks",
    "model-operation-callers",
  ]) {
    test(`${id} confines execution to checking owners`, async () => {
      const entry = OWNERSHIP.find((candidate) => candidate.id === id);
      if (entry?.enforcement.kind !== "import") {
        throw new TypeError("Checked operation ownership must confine imports");
      }
      const specifier = entry.enforcement.specifiers.at(0);
      const member = entry.enforcement.names?.at(0);
      if (!specifier || !member) {
        throw new TypeError("Checked operation ownership needs a named import");
      }
      const source = [
        `import { ${member} as unchecked } from "${specifier}";`,
        `import * as core from "${specifier}";`,
        `export { ${member} } from "${specifier}";`,
        `const { ${member} } = await import("${specifier}");`,
      ].join("\n");
      const sourcePaths = [
        "apps/api/src/handlers/example/unchecked.ts",
        "apps/api/src/mcp/unchecked.ts",
        "apps/api/src/lib/scheduler/tasks/unchecked.ts",
        ...entry.owner,
      ];
      const linesBySource = await lintRuleAcrossFiles(
        "confine-owner",
        Object.fromEntries(
          sourcePaths.map((sourcePath) => [sourcePath, source]),
        ),
        { ruleOptions: { entries: [entry] } },
      );
      expect(linesBySource).toEqual(
        Object.fromEntries(
          sourcePaths.map((sourcePath, index) => [
            sourcePath,
            index < 3 ? [1, 2, 3, 4] : [],
          ]),
        ),
      );
    });
  }
});

test("RTF code-page decoding stays in the document reader", async () => {
  const entry = OWNERSHIP.find(({ id }) => id === "rtf-reader");
  const source = 'const control = "ansicpg";';
  expect(
    await lintSingleRule("confine-owner", source, {
      ruleOptions: { entries: [entry] },
      sourcePath:
        "apps/api/src/handlers/case-law/ingestion/parsers/second-reader.ts",
    }),
  ).toEqual([1]);
  expect(
    await lintSingleRule("confine-owner", source, {
      ruleOptions: { entries: [entry] },
      sourcePath: "apps/api/src/lib/legal-search/parsers/rtf-reader.ts",
    }),
  ).toEqual([]);
});

test("the AI label is reached only through a typed disclosure context", async () => {
  const entry = OWNERSHIP.find(({ id }) => id === "ai-disclosure-label");
  expect(entry).toBeDefined();
  const options = { ruleOptions: { entries: [entry] } };
  const results = await Promise.all(
    [
      'import { AiLabel } from "@stll/ui/ai-label";',
      'import { AiLabel } from "@stll/ui/components/ai-label";',
    ].map(async (lintCase, index) => {
      const source = lintCase;
      const rejectedPaths = [
        "apps/web/src/features/chat/components/answer-mark.tsx",
        "apps/web/src/components/ai-disclosure-label.tsx",
        "packages/decision-reader/src/headnote-block.tsx",
        "apps/desktop/src/renderer/ai-mark.tsx",
      ];
      const ownerPath = "packages/decision-reader/src/reader-ai-label.tsx";
      const sourcePaths = [...rejectedPaths, ownerPath];

      return {
        label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
        result: await lintRuleAcrossFiles(
          "confine-owner",
          Object.fromEntries(
            sourcePaths.map((sourcePath) => [sourcePath, source]),
          ),
          options,
        ),
        expected: Object.fromEntries(
          sourcePaths.map((sourcePath) => [
            sourcePath,
            sourcePath === ownerPath ? [] : [1],
          ]),
        ),
      };
    }),
  );
  expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
    results.map(({ label, expected }) => ({ label, result: expected })),
  );
});

describe.serial("verification run evidence reads", () => {
  const entry = OWNERSHIP.find(
    ({ id }) => id === "verification-run-evidence-read",
  );
  const source = [
    'import { legalListVerificationRuns } from "@/api/db/schema";',
    "db.select({ evidence: legalListVerificationRuns.evidence }).from(legalListVerificationRuns);",
    "db.update(legalListVerificationRuns).set({ status: 'running' }).returning({ evidence: legalListVerificationRuns.evidence });",
    "db.select().from(legalListVerificationRuns);",
    "db.update(legalListVerificationRuns).set({ status: 'running' }).returning();",
    "db.select({ id: legalListVerificationRuns.id }).from(legalListVerificationRuns);",
    "db.update(legalListVerificationRuns).set({ status: 'running' }).returning({ id: legalListVerificationRuns.id });",
  ].join("\n");
  const options = {
    ruleOptions: { entries: [entry] },
    sourcePath: "apps/api/src/lib/lists/verification/run-queue.ts",
    cwd: "scratch",
  } as const;

  test("rejects foreign evidence selections and returning rows", async () => {
    expect(entry?.owner).toEqual([
      "apps/api/src/lib/lists/verification/read-run.ts",
    ]);
    expect(await lintSingleRule("confine-owner", source, options)).toEqual([
      2, 3, 4, 5,
    ]);
    expect(
      await lintSingleRule("confine-owner", source, {
        ...options,
        ruleOptions: { entries: [] },
      }),
    ).toEqual([]);
  });

  test("admits evidence reads inside the reader", async () => {
    expect(
      await lintSingleRule("confine-owner", source, {
        ...options,
        sourcePath: "apps/api/src/lib/lists/verification/read-run.ts",
      }),
    ).toEqual([]);
  });
});

describe("matter proof minting ownership", () => {
  const entry = OWNERSHIP.find(
    ({ id }) => id === "transaction-proof-predicates",
  );
  const sourcePath = "apps/api/src/lib/workspaces/consumer.ts";

  test("rejects minting imports and re-exports outside trusted predicates", async () => {
    const sources = [
      'import { withCheckedTransaction as mint } from "@/api/lib/proofs/checked-transaction";',
      'import * as mint from "../proofs/checked-transaction.ts";',
      'export { withCheckedTransaction as mint } from "@/api/lib/proofs/checked-transaction";',
      'export * from "../proofs/checked-transaction";',
      'const mint = await import("@/api/lib/proofs/checked-transaction");',
    ];
    const results = await Promise.all(
      sources.map(async (lintCase, index) => {
        const source = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lintSingleRule("confine-owner", source, {
            ruleOptions: { entries: [entry] },
            sourcePath,
            cwd: "scratch",
          }),
          expected: [1],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
  });

  test("admits the matter predicate through the production ownership declaration", async () => {
    expect(entry?.owner).toContain(
      "apps/api/src/lib/workspaces/matter-access-proof.ts",
    );
    expect(
      await lintSingleRule(
        "confine-owner",
        'import { withCheckedTransaction } from "@/api/lib/proofs/checked-transaction";',
        {
          ruleOptions: { entries: [entry] },
          sourcePath: "apps/api/src/lib/workspaces/matter-access-proof.ts",
          cwd: "scratch",
        },
      ),
    ).toEqual([]);
  });
});
