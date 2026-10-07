import { describe, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";

import { OWNERSHIP } from "../../scripts/ownership.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

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
    for (const sourcePath of [
      ...entry.owner,
      ...entry.enforcement.allowed.map(({ path: allowedPath }) => allowedPath),
    ]) {
      expect(
        await lintSingleRule("confine-owner", source, {
          ruleOptions: { entries: [entry] },
          sourcePath,
        }),
      ).toEqual([]);
    }
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
    for (const sourcePath of [
      "apps/api/src/lib/legal-search/new-scan.ts",
      "apps/api/src/handlers/new-search.ts",
    ]) {
      expect(
        await lintSingleRule("confine-owner", source, {
          ruleOptions,
          sourcePath,
        }),
      ).toEqual([1, 2, 3, 4]);
    }
  });

  test("accepts the hit classifier and the candidate query owners", async () => {
    expect(
      await lintSingleRule("confine-owner", "extractId(hit);", {
        ruleOptions,
        sourcePath: "apps/api/src/lib/legal-search/corpus-hit-disposition.ts",
      }),
    ).toEqual([]);
    for (const sourcePath of [
      "apps/api/src/handlers/case-law/decisions/search.ts",
      "apps/api/src/lib/legal-search/corpus-index-provider.ts",
      "apps/api/src/lib/legal-search/corpus-rehydration-disposition.ts",
      "apps/api/src/handlers/case-law/decisions/search-hydration.db.test.ts",
    ]) {
      expect(
        await lintSingleRule(
          "confine-owner",
          source.split("\n").slice(1).join("\n"),
          {
            ruleOptions,
            sourcePath,
          },
        ),
      ).toEqual([]);
    }
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
    expect(storedContentEntries.map(({ id }) => id)).toEqual([
      "stored-file-read",
      "stored-tenant-file-read",
      "audited-download-grant",
      "content-delivery-intent",
      "content-delivery-receipt",
      "content-delivery-scope",
    ]);
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
  for (const sourcePath of [
    "apps/web/src/components/translate-document-dialog.tsx",
    "apps/web/src/components/workspaces/row-actions.tsx",
    "apps/web/src/components/other-dialog.tsx",
  ]) {
    expect(
      await lintSingleRule("confine-owner", source, {
        ruleOptionsForRoot: (root) => ({
          entries: OWNERSHIP.filter(
            ({ id }) => id === "deepl-availability",
          ).map((entry) => ({
            ...entry,
            owner: entry.owner.map((owner) => path.join(root, owner)),
          })),
        }),
        sourcePath,
      }),
    ).toEqual(sourcePath.endsWith("/translate-document-dialog.tsx") ? [] : [1]);
  }
});

test("desktop observations are confined to service and membership cleanup", async () => {
  const entry = OWNERSHIP.find(
    ({ id }) => id === "desktop-presence-observations",
  );
  if (entry?.enforcement.kind !== "import") {
    throw new TypeError("Missing desktop presence ownership");
  }
  const source = 'import { desktopPresence } from "@/api/db/schema";';
  expect(
    await lintSingleRule("confine-owner", source, {
      ruleOptions: { entries: [entry] },
      sourcePath: "apps/api/src/handlers/desktop-presence/other.ts",
    }),
  ).toEqual([1]);
  for (const sourcePath of [
    ...entry.owner,
    ...entry.enforcement.allowed.map(({ path: allowedPath }) => allowedPath),
  ]) {
    expect(
      await lintSingleRule("confine-owner", source, {
        ruleOptions: { entries: [entry] },
        sourcePath,
      }),
    ).toEqual([]);
  }
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
    for (const sourcePath of [
      "apps/api/src/lib/signals/proofs/second-mint.ts",
      "apps/api/src/lib/proofs/second-mint.ts",
      "apps/api/src/handlers/signals/unchecked.ts",
    ]) {
      expect(
        await lintSingleRule("confine-owner", source, {
          sourcePath,
          ruleOptions: { entries: [entry] },
        }),
      ).toEqual([1, 2, 3, 4, 5]);
    }
    for (const sourcePath of entry.owner) {
      expect(
        await lintSingleRule("confine-owner", source, {
          sourcePath,
          ruleOptions: { entries: [entry] },
        }),
      ).toEqual([]);
    }
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
    expect(
      await lintSingleRule("confine-owner", source, {
        sourcePath: "apps/api/src/handlers/signals/unchecked.ts",
        ruleOptions: { entries: [entry] },
      }),
    ).toEqual([1, 2]);
    for (const sourcePath of entry.owner) {
      expect(
        await lintSingleRule("confine-owner", source, {
          sourcePath,
          ruleOptions: { entries: [entry] },
        }),
      ).toEqual([]);
    }
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
      for (const sourcePath of [
        "apps/api/src/handlers/example/unchecked.ts",
        "apps/api/src/mcp/unchecked.ts",
        "apps/api/src/lib/scheduler/tasks/unchecked.ts",
      ]) {
        expect(
          await lintSingleRule("confine-owner", source, {
            sourcePath,
            ruleOptions: { entries: [entry] },
          }),
        ).toEqual([1, 2, 3, 4]);
      }
      for (const sourcePath of entry.owner) {
        expect(
          await lintSingleRule("confine-owner", source, {
            sourcePath,
            ruleOptions: { entries: [entry] },
          }),
        ).toEqual([]);
      }
    });
  }
});
