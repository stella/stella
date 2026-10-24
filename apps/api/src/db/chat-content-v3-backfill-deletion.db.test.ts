import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  backfillChatContentV3Batch,
  CHAT_CONTENT_V3_SOURCES,
} from "./chat-content-v3-backfill";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (enabled && databaseUrl === undefined) {
  panic("Chat content backfill deletion tests require DATABASE_URL");
}

const legacyContent = {
  version: 1,
  data: [{ type: "text", text: "Before deletion" }],
};
const currentContent = {
  version: 3,
  data: [{ type: "text", content: "Already current" }],
};
const invalidContent = { version: 1, data: [{ type: "unsupported" }] };

type DeletionCase = {
  content: typeof legacyContent | typeof currentContent | typeof invalidContent;
  name: string;
  source: keyof typeof CHAT_CONTENT_V3_SOURCES;
};

const runDeletionRace = async ({ content, source }: DeletionCase) => {
  const url =
    databaseUrl ??
    panic("Chat content backfill deletion tests require DATABASE_URL");

  await withGatedTestClients(url, async ({ openClient }) => {
    const connectionA = openClient({ max: 1 });
    const connectionB = openClient({ max: 1 });
    const schema = `chat_content_v3_delete_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    const messageId = Bun.randomUUIDv7();
    const organizationId = `org_${Bun.randomUUIDv7()}`;
    const threadId = Bun.randomUUIDv7();
    const rowId = source === "message" ? messageId : Bun.randomUUIDv7();

    await connectionA.sql.unsafe(`CREATE SCHEMA ${schema}`);
    await connectionA.sql.unsafe(
      `SET search_path TO ${schema}, pg_catalog, public`,
    );
    await connectionB.sql.unsafe(
      `SET search_path TO ${schema}, pg_catalog, public`,
    );

    try {
      await connectionA.sql.unsafe(
        "CREATE TABLE organization (id text PRIMARY KEY)",
      );
      await connectionA.sql.unsafe(`CREATE TABLE chat_threads (
        id uuid PRIMARY KEY,
        organization_id text NOT NULL REFERENCES organization (id) ON DELETE CASCADE
      )`);
      await connectionA.sql.unsafe(`
        CREATE TABLE chat_messages (
          id uuid PRIMARY KEY,
          thread_id uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
          content jsonb NOT NULL
        )
      `);
      await connectionA.sql.unsafe(`
        CREATE TABLE chat_message_revisions (
          id uuid PRIMARY KEY,
          message_id uuid NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
          content jsonb NOT NULL
        )
      `);

      const migration = await Bun.file(
        new URL(
          "../../drizzle/20261010234000_chat_content_v3_backfill_receipts/migration.sql",
          import.meta.url,
        ),
      ).text();
      const createReceipts =
        /CREATE TABLE "chat_content_v3_backfill_receipts" \([\s\S]*?\);/u.exec(
          migration,
        )?.[0];
      if (createReceipts === undefined) {
        panic(
          "Backfill receipt migration is missing its CREATE TABLE statement",
        );
      }
      await connectionA.sql.unsafe(createReceipts);
      // The race runs under the receipts' forced owner-only row security,
      // pointed at this schema's copy of the table.
      const receiptRowSecurity = migration
        .split("--> statement-breakpoint")
        .map((statement) => statement.replace(/^(?:\s*--[^\n]*\n)*\s*/u, ""))
        .filter(
          (statement) =>
            statement.startsWith(
              'ALTER TABLE "chat_content_v3_backfill_receipts" ENABLE',
            ) ||
            statement.startsWith(
              'ALTER TABLE "chat_content_v3_backfill_receipts" FORCE',
            ) ||
            statement.startsWith(
              'CREATE POLICY "chat_content_v3_backfill_receipts_owner_access"',
            ),
        )
        .map((statement) =>
          statement.replaceAll(
            "'public.chat_content_v3_backfill_receipts'",
            () => `'${schema}.chat_content_v3_backfill_receipts'`,
          ),
        );
      expect(receiptRowSecurity).toHaveLength(3);
      for (const statement of receiptRowSecurity) {
        await connectionA.sql.unsafe(statement);
      }
      expect([
        ...(await connectionA.sql.unsafe<
          { forced: boolean; policies: number }[]
        >(
          `SELECT relforcerowsecurity AS forced,
                  (SELECT count(*)::int FROM pg_policy WHERE polrelid = '${schema}.chat_content_v3_backfill_receipts'::regclass) AS policies
           FROM pg_class
           WHERE oid = '${schema}.chat_content_v3_backfill_receipts'::regclass`,
        )),
      ]).toEqual([{ forced: true, policies: 1 }]);

      await connectionA.sql.unsafe(
        "INSERT INTO organization (id) VALUES ($1)",
        [organizationId],
      );
      await connectionA.sql.unsafe(
        "INSERT INTO chat_threads (id, organization_id) VALUES ($1, $2)",
        [threadId, organizationId],
      );

      await connectionA.sql.unsafe(
        "INSERT INTO chat_messages (id, thread_id, content) VALUES ($1, $2, $3::text::jsonb)",
        [messageId, threadId, JSON.stringify(currentContent)],
      );
      if (source === "message") {
        await connectionA.sql.unsafe(
          "UPDATE chat_messages SET content = $2::text::jsonb WHERE id = $1",
          [rowId, JSON.stringify(content)],
        );
      } else {
        await connectionA.sql.unsafe(
          "INSERT INTO chat_message_revisions (id, message_id, content) VALUES ($1, $2, $3::text::jsonb)",
          [rowId, messageId, JSON.stringify(content)],
        );
      }

      expect([
        ...(await connectionA.sql.unsafe<{ content: unknown }[]>(
          `SELECT content FROM ${CHAT_CONTENT_V3_SOURCES[source].table}`,
        )),
      ]).toEqual([{ content }]);

      const selected = Promise.withResolvers<undefined>();
      const resumeBatch = Promise.withResolvers<undefined>();
      let intercepted = false;
      const tx: OnlineMigrationConnection = {
        execute: async (query, params = []) => {
          await connectionA.sql.unsafe(query, [...params]);
        },
        query: async (query, params = []) => {
          const rows = await connectionA.sql.unsafe(query, [...params]);
          if (
            !intercepted &&
            query.trimStart().startsWith("SELECT target.id,")
          ) {
            intercepted = true;
            selected.resolve(undefined);
            await resumeBatch.promise;
          }
          return rows;
        },
        release: () => undefined,
      };

      await connectionA.sql.unsafe("BEGIN");
      let transactionOpen = true;
      try {
        const batch = backfillChatContentV3Batch({
          tx,
          source,
          cursor: null,
          size: 10,
        });
        await selected.promise;
        await connectionB.sql.unsafe(
          "DELETE FROM chat_messages WHERE id = $1",
          [messageId],
        );
        resumeBatch.resolve(undefined);
        const result = await batch;
        await connectionA.sql.unsafe("COMMIT");
        transactionOpen = false;

        expect(intercepted).toBe(true);
        expect(result).toMatchObject({ cursor: rowId, done: false });
        expect(result.value).toEqual([
          {
            row_id: rowId,
            message_id: messageId,
            organization_id: organizationId,
            from_version: content.version,
            outcome: "deleted-concurrently",
            reason: "parent-deleted",
          },
        ]);

        const receipts = await connectionA.sql.unsafe(
          "SELECT source, row_id, message_id, organization_id, from_version, outcome, reason FROM chat_content_v3_backfill_receipts",
        );
        expect(receipts).toEqual([
          {
            source,
            row_id: rowId,
            message_id: messageId,
            organization_id: organizationId,
            from_version: content.version,
            outcome: "deleted-concurrently",
            reason: "parent-deleted",
          },
        ]);

        const nextBatch = await backfillChatContentV3Batch({
          tx,
          source,
          cursor: result.cursor,
          size: 10,
        });
        expect(nextBatch).toMatchObject({
          cursor: rowId,
          done: true,
          value: [],
        });
        expect([
          ...(await connectionA.sql.unsafe<{ id: string }[]>(
            "SELECT id FROM chat_messages",
          )),
        ]).toEqual([]);
        expect([
          ...(await connectionA.sql.unsafe<{ id: string }[]>(
            "SELECT id FROM chat_message_revisions",
          )),
        ]).toEqual([]);
        await connectionB.sql.unsafe("DELETE FROM organization WHERE id = $1", [
          organizationId,
        ]);
        expect([
          ...(await connectionA.sql.unsafe<{ row_id: string }[]>(
            "SELECT row_id FROM chat_content_v3_backfill_receipts",
          )),
        ]).toEqual([]);
      } finally {
        resumeBatch.resolve(undefined);
        if (transactionOpen) {
          await connectionA.sql.unsafe("ROLLBACK");
        }
      }
    } finally {
      await connectionA.sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    }
  });
};

describe.skipIf(!enabled)(
  "chat content v3 backfill records parent deletions",
  () => {
    test.each([
      { content: legacyContent, name: "legacy message", source: "message" },
      { content: legacyContent, name: "legacy revision", source: "revision" },
      { content: currentContent, name: "current message", source: "message" },
      { content: invalidContent, name: "invalid message", source: "message" },
    ] satisfies DeletionCase[])(
      "records $name deletion after the batch SELECT",
      runDeletionRace,
      30_000,
    );
  },
);
