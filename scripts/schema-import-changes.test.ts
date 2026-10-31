import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { schemaEntries, schemaImportsChanged } from "./schema-import-changes";

const root = path.resolve(import.meta.dir, "..");

test("the schema entries are the files drizzle-kit reads", () => {
  const config = readFileSync(
    path.join(root, "apps/api/drizzle.config.ts"),
    "utf-8",
  );
  const entries = schemaEntries(root);
  expect(entries).toContain("apps/api/src/db/schema.ts");
  for (const entry of entries) {
    expect(config).toContain(`./${entry.replace(/^apps\/api\//u, "")}`);
  }
});

test("a value the schema imports from outside the migration paths selects the migration jobs", () => {
  // The chat schema imports its turn statuses from an API library.
  expect(
    schemaImportsChanged({
      root,
      changed: ["apps/api/src/lib/chat/turn-status.ts"],
    }),
  ).toBe(true);
  expect(
    schemaImportsChanged({ root, changed: ["docs/architecture.md"] }),
  ).toBe(false);
});

test("the plan's migration output includes schema import changes", () => {
  const workflow = readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf-8",
  );
  expect(workflow).toContain(
    `database_migrations_required: \${{ (steps.changed-files.outputs.database_migrations_required == 'true' || steps.schema-imports.outputs.changed == 'true') && 'true' || 'false' }}`,
  );
  expect(workflow).toContain("bun scripts/schema-import-changes.ts");
});
