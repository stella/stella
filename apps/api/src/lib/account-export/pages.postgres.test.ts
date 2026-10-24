import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import JSZip from "jszip";

import { ACCOUNT_EXPORT_PROJECTIONS } from "@/api/account-export-projections";
import { member, organization, user } from "@/api/db/auth-schema";
import {
  aiMemories,
  contacts,
  searchHistoryEntries,
  workspaces,
} from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import { prepareSearchHistoryRows } from "@/api/handlers/search-history/entries";
import {
  type AccountExportArchiveDeps,
  buildAccountExportArchive,
} from "@/api/lib/account-export/archive";
import {
  exportAccountFiles,
  exportAccountRows,
} from "@/api/lib/account-export/pages";
import {
  ACCOUNT_EXPORT_REGISTRY,
  EXPORTED_ACCOUNT_TABLE_NAMES,
} from "@/api/lib/account-export/registry";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("account export personal data", () => {
  test("projects encrypted personal history across memberships into the archive", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const scopedDatabase = markRlsDatabase(db);
      const organizations = [
        mintAuthProviderId<"organization">(),
        mintAuthProviderId<"organization">(),
      ];
      const organizationA = organizations.at(0);
      const organizationB = organizations.at(1);
      if (organizationA === undefined || organizationB === undefined) {
        panic("Two organization fixtures required");
      }
      const userId = mintAuthProviderId<"user">();
      const users = [userId];
      const workspaceId = createSafeId<"workspace">();
      const queries = ["First account query", "Second account query"];
      await db.insert(user).values(
        users.map((id) => ({
          id,
          name: "Export member",
          email: `${id}@example.test`,
        })),
      );
      try {
        await db.insert(organization).values(
          organizations.map((id) => ({
            id,
            name: "Export organization",
            slug: id,
            createdAt: new Date(),
          })),
        );
        await db.insert(member).values(
          organizations.flatMap((organizationId) =>
            users.map((memberUserId) => ({
              id: Bun.randomUUIDv7(),
              organizationId,
              userId: memberUserId,
              role: "member",
              createdAt: new Date(),
            })),
          ),
        );
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId: organizationA,
          name: "Export matter fixture",
          reference: Bun.randomUUIDv7(),
        });
        await db.insert(contacts).values({
          organizationId: organizationA,
          createdBy: userId,
          type: "person",
          displayName: "Organization contact fixture",
        });
        const prepared = await Promise.all(
          organizations.map(async (organizationId, index) => {
            const query = queries.at(index);
            if (query === undefined) {
              panic("Organization query fixture required");
            }
            return await prepareSearchHistoryRows({ organizationId, userId }, [
              { entry: { kind: "search", query }, usedAt: new Date() },
            ]);
          }),
        );
        const historyRows = prepared.flat();
        for (const row of historyRows) {
          expect(row.iv.every((byte) => byte === 0)).toBe(false);
          for (const query of queries) {
            expect(row.ciphertext.includes(Buffer.from(query))).toBe(false);
          }
        }
        await db.insert(searchHistoryEntries).values(historyRows);
        await db.insert(aiMemories).values([
          {
            organizationId: organizationA,
            scope: "organization",
            kind: "instruction",
            content: "Organization memory fixture",
            dedupKey: "a".repeat(64),
            source: "user",
            createdBy: userId,
          },
          {
            organizationId: organizationA,
            scope: "workspace",
            workspaceId,
            kind: "fact",
            content: "Matter memory fixture",
            dedupKey: "b".repeat(64),
            source: "user",
            createdBy: userId,
          },
        ]);

        const archiveFor = async (exportUserId: SafeId<"user">) => {
          const published: Uint8Array[] = [];
          const deps = {
            rows: (options) =>
              exportAccountRows({ ...options, scopedDatabase }),
            files: (options) =>
              exportAccountFiles({ ...options, scopedDatabase }),
            openObject: async () => panic("The fixture has no personal files"),
            publish: async (_key, bytes) => {
              if (!(bytes instanceof Blob)) {
                panic("Expected the archive spool");
              }
              published.push(new Uint8Array(await bytes.arrayBuffer()));
            },
          } satisfies AccountExportArchiveDeps;
          await buildAccountExportArchive({
            projections: ACCOUNT_EXPORT_PROJECTIONS,
            db,
            userId: exportUserId,
            objectKey: "export-fixture.zip",
            signal: new AbortController().signal,
            deps,
          });
          const bytes = published.at(0);
          if (bytes === undefined) {
            panic("Archive publication required");
          }
          return await JSZip.loadAsync(bytes);
        };
        const archive = await archiveFor(userId);
        const historyText = await archive
          .file("search_history_entries.json")
          ?.async("string");
        if (historyText === undefined) {
          panic("History archive entry required");
        }
        const history: unknown = JSON.parse(historyText);
        expect(history).toHaveLength(2);
        expect(history).toEqual(
          expect.arrayContaining([
            {
              organizationId: organizationA,
              data: expect.objectContaining({
                kind: "search",
                query: queries.at(0),
              }),
            },
            {
              organizationId: organizationB,
              data: expect.objectContaining({
                kind: "search",
                query: queries.at(1),
              }),
            },
          ]),
        );
        expect(await archive.file("ai_memories.json")?.async("string")).toBe(
          "[]",
        );
        expect(Object.keys(archive.files).toSorted()).toEqual(
          [
            ...EXPORTED_ACCOUNT_TABLE_NAMES.map((table) => `${table}.json`),
            "manifest.json",
          ].toSorted(),
        );
        for (const [table, disposition] of Object.entries(
          ACCOUNT_EXPORT_REGISTRY,
        )) {
          if (disposition.type === "exempt") {
            expect(archive.file(`${table}.json`)).toBeNull();
          }
        }
      } finally {
        await db
          .delete(organization)
          .where(inArray(organization.id, organizations));
        await db.delete(user).where(inArray(user.id, users));
      }
    });
  });
});
