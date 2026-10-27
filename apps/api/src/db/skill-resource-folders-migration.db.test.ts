import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { hashSkillPackageContent } from "@/api/lib/agent-skills/content-hash";
import {
  RESOURCE_PATH_MAX_CHARS,
  RESOURCE_PATH_PATTERN,
} from "@/api/lib/agent-skills/resource-path";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { readCommittedMigrations } from "@/api/tests/stella-table-privileges";

import { MIGRATE_ONLINE_WORK_MODE } from "./migrate-online-work-mode";
import { runMigrations } from "./migration-runner";

const migrationName = "20261010005100_standard_skill_resource_folders";
const migrationsFolder = path.resolve(import.meta.dir, "../../drizzle");
const migration = readFileSync(
  path.join(migrationsFolder, migrationName, "migration.sql"),
  "utf-8",
).replaceAll("--> statement-breakpoint", "");
const fields = {
  body: "Pokyny: porovnej přílohy. 🗂️",
  compatibility: "Stella",
  description: "Český test migrace",
  license: null,
  metadata: { "stella-display-name": "Přílohy", "stella-required-tools": "" },
  name: "migration-fixture",
  version: "",
};
const resources = [
  { path: "knowledge/checklist.md", content: "Původní poznámky" },
  { path: "references/checklist.md", content: "Existing destination" },
  { path: "templates/draft.txt", content: "Návrh 📝" },
  { path: "prompts/review.md", content: "Review" },
  { path: "reference/citations.md", content: "Citations" },
  { path: "scripts/companion.py", content: "read templates/draft.txt" },
] as const;
const renamedResources = [
  { ...resources[0], path: "references/checklist-2.md" },
  resources[1],
  { ...resources[2], path: "assets/draft.txt" },
  { ...resources[3], path: "references/review.md" },
  { ...resources[4], path: "references/citations.md" },
  { ...resources[5], content: "read assets/draft.txt" },
];
const referenceBody =
  "[Checklist](./knowledge/checklist.md) read knowledge/checklist.md; knowledge/checklist.md.bak x/knowledge/checklist.md ../knowledge/checklist.md x./knowledge/checklist.md unrelated/a.md " +
  "(knowledge/a+[1].md) knowledge/axb1.md knowledge/a+[1].md.bak";
const referenceResources = [
  { path: "knowledge/checklist.md", content: "Checklist" },
  { path: "references/checklist.md", content: "Destination" },
  { path: "templates/form.docx", content: "Form" },
  { path: "knowledge/a+[1].md", content: "Literal filename" },
  {
    path: "scripts/companion.py",
    content:
      "read './templates/form.docx'; ./knowledge/checklist.md templates/form.docx knowledge/checklist.md knowledge/checklist.md.bak x/knowledge/checklist.md ../knowledge/checklist.md unrelated/a.md",
  },
] as const;
const rewrittenBody = referenceBody
  .replace(
    "[Checklist](./knowledge/checklist.md)",
    "[Checklist](./references/checklist-2.md)",
  )
  .replace("read knowledge/checklist.md;", "read references/checklist-2.md;")
  .replace("(knowledge/a+[1].md)", "(references/a-1-.md)");
const rewrittenResources = [
  { ...referenceResources[0], path: "references/checklist-2.md" },
  referenceResources[1],
  { ...referenceResources[2], path: "assets/form.docx" },
  { ...referenceResources[3], path: "references/a-1-.md" },
  {
    ...referenceResources[4],
    content:
      "read './assets/form.docx'; ./references/checklist-2.md assets/form.docx references/checklist-2.md knowledge/checklist.md.bak x/knowledge/checklist.md ../knowledge/checklist.md unrelated/a.md",
  },
];
const longStem = "a".repeat(501);
const collidingStem = "e".repeat(501);
const longResources = [
  { path: `prompts/${longStem}.md`, content: "Long path" },
  { path: `prompts/${collidingStem}.md`, content: "Long colliding path" },
  { path: `references/${"e".repeat(498)}.md`, content: "Unsuffixed" },
  ...Array.from({ length: 8 }, (_, index) => ({
    path: `references/${"e".repeat(496)}-${index + 2}.md`,
    content: `Collision ${index + 2}`,
  })),
] as const;
const renamedLongResources = [
  { ...longResources[0], path: `references/${"a".repeat(498)}.md` },
  { ...longResources[1], path: `references/${"e".repeat(495)}-10.md` },
  ...longResources.slice(2),
];
const longExtensionPath = `prompts/a.${"x".repeat(502)}`;
const fittedLongExtensionPath = `references/a.${"x".repeat(499)}`;
const collidingLongExtensionPath = `references/a.${"x".repeat(497)}-2`;
const longExtensionResource = {
  path: longExtensionPath,
  content: `read (${longExtensionPath})`,
};

const nestedCases = [
  {
    source: `prompts/${"a".repeat(497)}/abc.md`,
    destination: `references/${"a".repeat(497)}/abc`,
    collision: `references/${"a".repeat(497)}/a-2`,
  },
  {
    source: `prompts/${"b".repeat(497)}/a.md`,
    destination: `references/${"b".repeat(497)}/a.m`,
    collision: `references/${"b".repeat(497)}/a-2`,
  },
  {
    source: `prompts/${"c".repeat(500)}/a`,
    destination: "references/a",
    collision: "references/a-2",
  },
  {
    source: `prompts/${"d".repeat(495)}/a..b.md`,
    destination: `references/${"d".repeat(495)}/a.md`,
    collision: `references/${"d".repeat(495)}/a-2`,
  },
  {
    source: `prompts/a.${"x".repeat(494)}..b.md`,
    destination: `references/a.${"x".repeat(494)}.md`,
    collision: `references/a.${"x".repeat(494)}-2.md`,
  },
  {
    source: "prompts/invalid./abc.md",
    destination: "references/abc.md",
    collision: "references/abc-2.md",
  },
  {
    source: "prompts/_abc.md",
    destination: "references/abc.md",
    collision: "references/abc-2.md",
  },
  {
    source: "prompts/a...",
    destination: "references/a",
    collision: "references/a-2",
  },
  {
    source: "prompts/🗂.md",
    destination: "references/resource.md",
    collision: "references/resource-2.md",
  },
] as const;
const nestedFixtures = nestedCases.flatMap(
  ({ source, destination, collision }) =>
    ["vacant", "collision"].map((mode) => {
      const newPath = mode === "vacant" ? destination : collision;
      const occupied =
        mode === "vacant"
          ? []
          : [{ path: destination, content: "Destination" }];
      return {
        body: `read (${source})`,
        resources: [{ path: source, content: `read (${source})` }, ...occupied],
        renamed: [{ path: newPath, content: `read (${newPath})` }, ...occupied],
        newBody: `read (${newPath})`,
      };
    }),
);

// The real migrator builds a fresh database up to the cutover. Cluster roles
// outlive scratch databases, so only their CREATE statements need guards.
const withPreCutoverDatabase = async (
  verify: (databaseUrl: string) => Promise<void>,
) => {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? panic("DATABASE_URL is required");
  const bundle = mkdtempSync(path.join(tmpdir(), "stella-skill-folders-"));
  try {
    for (const { name, sql } of readCommittedMigrations()) {
      if (name >= migrationName) {
        continue;
      }
      mkdirSync(path.join(bundle, name));
      writeFileSync(
        path.join(bundle, name, "migration.sql"),
        sql.replace(
          /CREATE ROLE ([a-z_][a-z0-9_]*) NOLOGIN;/gu,
          (_statement, role: string) =>
            `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$;`,
        ),
      );
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const admin = openClient().sql;
      const name = `stella_skill_folders_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      try {
        const url = new URL(databaseUrl);
        url.pathname = `/${name}`;
        const scratchUrl = url.toString();
        await withGatedTestClients(
          scratchUrl,
          async ({ openClient: openScratch }) => {
            const connection = await openScratch().sql.reserve();
            try {
              const result = await runMigrations({
                onlineWorkMode: MIGRATE_ONLINE_WORK_MODE.BUILD_FINALIZED,
                connection,
                databaseUrl: scratchUrl,
                migrationsFolder: bundle,
                ebs: { type: "disabled" },
                // Current online repairs target the fully migrated schema;
                // this fixture needs only the real pre-cutover DDL and triggers.
                runOnline: async () => ({ type: "complete" }),
              });
              expect(result.status).toBe("applied");
            } finally {
              await connection.release();
            }
            await verify(scratchUrl);
          },
        );
      } finally {
        await admin.unsafe(`DROP DATABASE "${name}"`);
      }
    });
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
};

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "real PostgreSQL folder migration",
  () => {
    test("bounded unique destinations, exact same-skill references, hash parity and revision history", async () => {
      await withPreCutoverDatabase(async (databaseUrl) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const client = openClient().sql;
          await client.begin(async (tx) => {
            expect([
              ...(await tx.unsafe<{ character_maximum_length: number }[]>(
                "SELECT character_maximum_length FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_skill_resources' AND column_name = 'path'",
              )),
            ]).toEqual([{ character_maximum_length: 512 }]);
            await tx.unsafe(
              "INSERT INTO organization (id, name, slug, created_at) VALUES ('folder-org', 'Fixture', 'folder-org', now())",
            );
            await tx.unsafe(
              `INSERT INTO "user" (id, name, email) VALUES ('folder-user', 'Fixture', 'folder-fixture@example.test')`,
            );
            // Exercise the trigger's recent same-actor coalescing branch: the
            // migration must explicitly isolate its rewrite from this revision.
            await tx.unsafe(
              "SELECT set_config('app.user_id', 'folder-user', true)",
            );
            const fixtures = [
              ...nestedFixtures,
              {
                body: "[Checklist](./knowledge/checklist.md)",
                resources: [referenceResources[0]],
                renamed: [
                  { ...referenceResources[0], path: "references/checklist.md" },
                ],
                newBody: "[Checklist](./references/checklist.md)",
              },
              {
                body: fields.body,
                resources,
                renamed: renamedResources,
                newBody: fields.body,
              },
              {
                body: referenceBody,
                resources: referenceResources,
                renamed: rewrittenResources,
                newBody: rewrittenBody,
              },
              {
                body: fields.body,
                resources: longResources,
                renamed: renamedLongResources,
                newBody: fields.body,
              },
              {
                body: `read (${longExtensionPath})`,
                resources: [longExtensionResource],
                renamed: [
                  {
                    path: fittedLongExtensionPath,
                    content: `read (${fittedLongExtensionPath})`,
                  },
                ],
                newBody: `read (${fittedLongExtensionPath})`,
              },
              {
                body: `read (${longExtensionPath})`,
                resources: [
                  longExtensionResource,
                  { path: fittedLongExtensionPath, content: "Destination" },
                ],
                renamed: [
                  {
                    path: collidingLongExtensionPath,
                    content: `read (${collidingLongExtensionPath})`,
                  },
                  { path: fittedLongExtensionPath, content: "Destination" },
                ],
                newBody: `read (${collidingLongExtensionPath})`,
              },
              {
                body: referenceBody,
                resources: [
                  {
                    path: "scripts/unrelated.py",
                    content: "templates/form.docx knowledge/checklist.md",
                  },
                ],
                renamed: [
                  {
                    path: "scripts/unrelated.py",
                    content: "templates/form.docx knowledge/checklist.md",
                  },
                ],
                newBody: referenceBody,
              },
            ];
            const seeded = [];
            for (const fixture of fixtures) {
              const id = Bun.randomUUIDv7();
              const oldHash = hashSkillPackageContent({
                ...fields,
                body: fixture.body,
                resources: fixture.resources,
              });
              const historicalHash = hashSkillPackageContent({
                ...fields,
                body: "Older instructions",
                resources: [],
              });
              expect(historicalHash).not.toBe(oldHash);
              await tx.unsafe(
                "INSERT INTO agent_skills (id, organization_id, user_id, scope, origin, slug, name, description, version, license, compatibility, metadata, body, content_hash) VALUES ($1::uuid, 'folder-org', 'folder-user', 'private', 'authored', $1::text, $2, $3, $4, $5, $6, $7::text::jsonb, 'Older instructions', $8)",
                [
                  id,
                  fields.name,
                  fields.description,
                  fields.version,
                  fields.license,
                  fields.compatibility,
                  JSON.stringify(fields.metadata),
                  historicalHash,
                ],
              );
              await tx.unsafe(
                "SELECT set_config('app.agent_skill_revision_mode', 'isolated', true)",
              );
              await tx.unsafe(
                "UPDATE agent_skills SET body = $2, content_hash = $3 WHERE id = $1",
                [id, fixture.body, oldHash],
              );
              await tx.unsafe(
                "SELECT set_config('app.agent_skill_revision_mode', '', true)",
              );
              for (const resource of fixture.resources) {
                expect(Array.from(resource.path).length).toBeLessThanOrEqual(
                  RESOURCE_PATH_MAX_CHARS,
                );
                await tx.unsafe(
                  "INSERT INTO agent_skill_resources (id, organization_id, skill_id, path, content, kind, size_bytes) VALUES ($1, 'folder-org', $2, $3, $4, 'knowledge', octet_length($4::text))",
                  [Bun.randomUUIDv7(), id, resource.path, resource.content],
                );
              }
              seeded.push({ ...fixture, id, oldHash, historicalHash });
            }
            for (const resource of longResources.slice(0, 2)) {
              expect(Array.from(resource.path)).toHaveLength(512);
            }
            expect(longExtensionPath).toHaveLength(512);
            for (const destination of [
              fittedLongExtensionPath,
              collidingLongExtensionPath,
            ]) {
              expect(destination.length).toBeLessThanOrEqual(512);
              expect(destination.startsWith("references/")).toBe(true);
            }
            expect(collidingLongExtensionPath).not.toBe(
              fittedLongExtensionPath,
            );
            await tx.unsafe(migration);
            for (const fixture of seeded) {
              const migratedResources = await tx.unsafe<
                { path: string; content: string }[]
              >(
                'SELECT path, content FROM agent_skill_resources WHERE skill_id = $1 ORDER BY path COLLATE "C"',
                [fixture.id],
              );
              for (const resource of migratedResources) {
                expect(RESOURCE_PATH_PATTERN.test(resource.path)).toBe(true);
                expect(resource.path.length).toBeLessThanOrEqual(
                  RESOURCE_PATH_MAX_CHARS,
                );
                for (const segment of resource.path.split("/")) {
                  expect(segment.endsWith(".")).toBe(false);
                }
              }
              expect(
                new Set(
                  migratedResources.map(
                    ({ path: resourcePath }) => resourcePath,
                  ),
                ).size,
              ).toBe(migratedResources.length);
              expect([...migratedResources]).toEqual(
                fixture.renamed.toSorted((a, b) =>
                  compareCodeUnit(a.path, b.path),
                ),
              );
              const newHash = hashSkillPackageContent({
                ...fields,
                body: fixture.newBody,
                resources: migratedResources,
              });
              expect([
                ...(await tx.unsafe<{ body: string; content_hash: string }[]>(
                  "SELECT body, content_hash FROM agent_skills WHERE id = $1",
                  [fixture.id],
                )),
              ]).toEqual([{ body: fixture.newBody, content_hash: newHash }]);
              const bodyChanged = fixture.body !== fixture.newBody;
              expect([
                ...(await tx.unsafe<
                  {
                    revision_number: number;
                    body: string;
                    content_hash: string;
                  }[]
                >(
                  "SELECT revision_number, body, content_hash FROM agent_skill_revisions WHERE skill_id = $1 ORDER BY revision_number",
                  [fixture.id],
                )),
              ]).toEqual([
                {
                  revision_number: 1,
                  body: "Older instructions",
                  content_hash: fixture.historicalHash,
                },
                {
                  revision_number: 2,
                  body: fixture.body,
                  content_hash: bodyChanged ? fixture.oldHash : newHash,
                },
                ...(bodyChanged
                  ? [
                      {
                        revision_number: 3,
                        body: fixture.newBody,
                        content_hash: newHash,
                      },
                    ]
                  : []),
              ]);
            }
            expect([
              ...(await tx.unsafe<{ count: number }[]>(
                "SELECT count(*)::integer AS count FROM agent_skill_resources WHERE char_length(path) > 512",
              )),
            ]).toEqual([{ count: 0 }]);
            expect([
              ...(await tx.unsafe<{ count: number }[]>(
                "SELECT count(*)::integer AS count FROM agent_skill_resources WHERE size_bytes <> octet_length(convert_to(content, 'UTF8'))",
              )),
            ]).toEqual([{ count: 0 }]);
            expect([
              ...(await tx.unsafe<{ column_name: string }[]>(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_skill_resources' AND column_name = 'kind'",
              )),
            ]).toEqual([]);
          });
        });
      });
    }, 300_000);
  },
);
