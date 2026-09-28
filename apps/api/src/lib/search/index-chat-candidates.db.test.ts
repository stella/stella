import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { CHAT_SEARCH_DISPLAY_METADATA_GENERATION } from "@/api/lib/search/chat-search-generation";
import { chatThreadBackfillCandidatesQuery } from "@/api/lib/search/index-chat";

const uuid = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

test("chat repair selects the same threads across cursor pages", async () => {
  await using client = await PGlite.create();
  await client.exec(`
    CREATE TABLE chat_threads (id uuid PRIMARY KEY);
    CREATE TABLE chat_thread_search_documents (
      thread_id uuid PRIMARY KEY,
      preview_generation uuid
    );
    CREATE TABLE chat_messages (id uuid PRIMARY KEY, thread_id uuid NOT NULL);
    CREATE INDEX chat_messages_thread_id_idx ON chat_messages (thread_id);
    CREATE TABLE chat_message_search_documents (message_id uuid PRIMARY KEY);
  `);

  const ids = Array.from({ length: 8 }, (_, index) => uuid(index + 1));
  await client.query(
    `INSERT INTO chat_threads (id) VALUES ($1), ($2), ($3), ($4), ($5), ($6), ($7), ($8)`,
    ids,
  );
  await client.query(
    `INSERT INTO chat_thread_search_documents (thread_id, preview_generation)
     SELECT id,
       CASE
         WHEN id IN ($2::uuid, $3::uuid) THEN $4::uuid
         WHEN id = $5::uuid THEN NULL
         ELSE $6::uuid
       END
     FROM chat_threads WHERE id <> $1::uuid`,
    [
      uuid(1),
      uuid(2),
      uuid(4),
      uuid(99),
      uuid(8),
      CHAT_SEARCH_DISPLAY_METADATA_GENERATION,
    ],
  );
  await client.query(
    `INSERT INTO chat_messages (id, thread_id)
     VALUES ($1, $1), ($2, $1), ($3, $3), ($4, $4), ($5, $5)`,
    [uuid(3), uuid(13), uuid(4), uuid(5), uuid(7)],
  );
  await client.query(
    `INSERT INTO chat_message_search_documents (message_id) VALUES ($1), ($2)`,
    [uuid(5), uuid(7)],
  );

  const oldPredicate = `
    SELECT t.id
    FROM chat_threads t
    LEFT JOIN chat_thread_search_documents d ON d.thread_id = t.id
    WHERE (
      d.thread_id IS NULL
      OR d.preview_generation IS DISTINCT FROM $2::uuid
      OR EXISTS (
        SELECT 1 FROM chat_messages m
        LEFT JOIN chat_message_search_documents md ON md.message_id = m.id
        WHERE m.thread_id = t.id AND md.message_id IS NULL
      )
    ) AND t.id > $1::uuid
    ORDER BY t.id
    LIMIT 200
  `;
  const dialect = new PgDialect();
  for (const [cursor, expected] of [
    [uuid(0), [1, 2, 3, 4, 8].map(uuid)],
    [uuid(2), [3, 4, 8].map(uuid)],
    [uuid(5), [8].map(uuid)],
  ] as const) {
    const query = dialect.sqlToQuery(chatThreadBackfillCandidatesQuery(cursor));
    const current = await client.query<{ id: string }>(query.sql, query.params);
    const previous = await client.query<{ id: string }>(oldPredicate, [
      cursor,
      CHAT_SEARCH_DISPLAY_METADATA_GENERATION,
    ]);
    expect(current.rows.map(({ id }) => id)).toEqual(expected);
    expect(current.rows).toEqual(previous.rows);
  }
});
