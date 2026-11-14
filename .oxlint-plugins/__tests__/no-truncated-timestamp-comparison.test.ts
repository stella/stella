import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects unsafe Drizzle boundary operands", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {gt,eq} from "drizzle-orm";
gt(rows.createdAt, cursor.createdAt);
eq(rows.updatedAt, cutoff);`,
    ),
  ).toEqual([2, 3]);
});

test("rejects raw SQL tuple and reverse timestamp comparisons", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {sql} from "drizzle-orm";
sql\`(\${rows.createdAt}, \${rows.id}) > (\${cursor.createdAt}, \${cursor.id})\`;
sql\`\${cutoff} < \${rows.updatedAt}\`;`,
    ),
  ).toEqual([2, 3]);
});

test("allows preserved PostgreSQL timestamp boundaries", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {sql} from "drizzle-orm";
sql\`\${rows.createdAt} > \${token}::timestamptz\`;`,
    ),
  ).toEqual([]);
});

test("allows fresh clock inequalities but requires preserved parameter boundaries", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {gt} from "drizzle-orm";
gt(rows.createdAt,new Date());
function before(cutoff:Date) {return gt(rows.createdAt,cutoff);}`,
    ),
  ).toEqual([3]);
});

test("allows test-kit clock cutoffs but rejects dates rebuilt from stored values", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {lt} from "drizzle-orm";
import {createTestClock} from "@stll/test-kit";
const testClock = createTestClock();
lt(rows.createdAt,new Date(testClock.now() - 60_000));
lt(rows.createdAt,new Date(cursor.createdAt));
const clockLookalike = {now: () => 0};
lt(rows.createdAt,new Date(clockLookalike.now()));`,
    ),
  ).toEqual([5, 7]);
});

test("keeps stored timestamp identifiers out of fresh clock arithmetic", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      [
        'import {lt} from "drizzle-orm";',
        'import {createTestClock} from "@stll/test-kit";',
        "const testClock = createTestClock();",
        "lt(rows.createdAt,new Date(testClock.now() * 0 + cursorMillis));",
        "lt(rows.createdAt,new Date(Date.now() + storedMillis));",
        "lt(rows.createdAt,new Date(testClock.now() - 60_000));",
      ].join("\n"),
    ),
  ).toEqual([4, 5]);
});

test("shifts a fresh clock read by named durations but not by stored values", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      [
        'import {lt} from "drizzle-orm";',
        'import {DAY_IN_MS, Temporal} from "@stll/time";',
        "const STALE_MS = 5 * 60 * 1000;",
        "const QUEUED_MS = DAY_IN_MS;",
        "const storedMillis = cursor.createdAt.getTime();",
        "lt(rows.createdAt,new Date(Date.now() - STALE_MS));",
        "lt(rows.createdAt,new Date(Temporal.Now.instant().epochMilliseconds - QUEUED_MS));",
        "const cutoff = new Date(Date.now() - 2 * STALE_MS);",
        "lt(rows.createdAt,cutoff);",
        "lt(rows.createdAt,new Date(Date.now() - storedMillis));",
        "let leaseMs = 1000;",
        "lt(rows.createdAt,new Date(Date.now() - leaseMs));",
      ].join("\n"),
    ),
  ).toEqual([10, 12]);
});

test("rejects timestamp text comparisons and allows the CAS helper", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {eq,sql} from "drizzle-orm";
sql\`\${rows.updatedAt}::text = \${token}\`;
sql\`\${token} = \${rows.updatedAt}::text\`;
eq(timestampCasToken(rows.updatedAt), token);
timestampMatchesCasToken(rows.updatedAt, token);
sql\`\${rows.id}::text = \${token}\`;
sql\`\${rows.updatedAt}::text\`;`,
    ),
  ).toEqual([2, 3, 4]);
});

test("rejects every spelling of a timestamp compared as text", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {eq,inArray,sql} from "drizzle-orm";
sql\`(\${rows.updatedAt})::varchar <> \${token}\`;
sql\`CAST(\${rows.updatedAt} AS text) = \${token}\`;
sql\`\${token} = CAST(\${rows.updatedAt} AS character varying)\`;
sql\`to_char(\${rows.updatedAt}, 'YYYY-MM-DD HH24:MI:SS.US') = \${token}\`;
sql\`\${timestampCasToken(rows.updatedAt)} = \${token}\`;
sql\`\${token} IS DISTINCT FROM \${timestampCasToken(rows.updatedAt)}\`;
sql\`\${rows.updatedAt}::text IN (\${first}, \${second})\`;
sql\`\${token} = CAST(updated_at AS text)\`;
sql\`WHERE to_char(t.updated_at, 'YYYY') = '2026'\`;
inArray(timestampCasToken(rows.updatedAt), tokens);
eq(sql\`CAST(\${rows.updatedAt} AS text)\`, token);
sql\`SELECT CAST(\${rows.updatedAt} AS text) AS revision\`;
sql\`\${rows.id}::text IN (\${first})\`;
sql\`UPDATE t SET note = \${timestampCasToken(rows.updatedAt)}\`;
inArray(rows.id, ids);
\`updated_at::text = '2026'\`;`,
    ),
  ).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("follows the token helper and the column through bindings and text wrappers", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {eq,sql} from "drizzle-orm";
import {timestampCasToken as casText} from "@/api/lib/db/timestamp-cas";
eq(casText(rows.updatedAt), token);
const tokenOf = timestampCasToken;
eq(tokenOf(rows.updatedAt), token);
eq(cas.timestampCasToken(rows.updatedAt), token);
sql\`\${rows.updatedAt}::text COLLATE "C" = \${token}\`;
sql\`coalesce(\${rows.updatedAt}::text, '') = \${token}\`;
sql\`\${rows.updatedAt}::text || 'Z' = \${token}\`;
const { updatedAt } = rows;
sql\`\${updatedAt}::text = \${token}\`;
sql\`\${rows["updatedAt"]}::text = \${token}\`;
sql.raw("WHERE updated_at::text = '2026'");
sql\`length(\${rows.updatedAt}::text) = 10\`;
sql\`\${rows[key]}::text = \${token}\`;
sql.raw("WHERE id::text = '2026'");`,
    ),
  ).toEqual([3, 5, 6, 7, 8, 9, 11, 12, 13]);
});

test("accepts a fixed duration built with exponentiation", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {lt} from "drizzle-orm";
const STALE_MS = 2 ** 10;
lt(rows.createdAt,new Date(Date.now() - STALE_MS));`,
    ),
  ).toEqual([]);
});

const lintDateUnderCast = async (source: string) =>
  await lintSingleRule("no-date-under-timestamp-cast", source, {
    plugin: "no-truncated-timestamp-comparison",
  });

test("rejects a stored timestamp read under an explicit cast", async () => {
  expect(
    await lintDateUnderCast(
      `import {sql,gt} from "drizzle-orm";
import {chatTurns} from "./schema";
function newer(turn: {id: string; createdAt: Date}) {
  return sql\`(\${chatTurns.createdAt}, \${chatTurns.id}) > (\${turn.createdAt}::timestamptz, \${turn.id}::uuid)\`;
}
sql\`\${chatTurns.updatedAt} IS NOT DISTINCT FROM \${row.updatedAt}::timestamptz\`;
sql\`created_at > \${row.createdAt.toISOString()}::timestamptz\`;
sql\`\${chatTurns.createdAt} > \${new Date(row.createdAt)}::timestamptz\`;
gt(chatTurns.createdAt, sql\`\${cursor.createdAt}::timestamptz\`);
const boundary = row.createdAt;
sql\`\${chatTurns.createdAt} <= (\${boundary}::timestamp AT TIME ZONE 'UTC')\`;`,
    ),
  ).toEqual([4, 6, 7, 8, 9, 11]);
});

test("rejects any Date rendering in a keyset tuple under an explicit cast", async () => {
  expect(
    await lintDateUnderCast(
      `import {sql} from "drizzle-orm";
import {events} from "./schema";
sql\`(\${events.createdAt}, \${events.id}) > (\${afterTime.toISOString()}::timestamptz, \${afterId}::uuid)\`;
sql\`(\${events.createdAt}, \${events.id}) < (\${new Date(after)}::timestamptz, \${afterId}::uuid)\`;`,
    ),
  ).toEqual([3, 4]);
});

test("rejects a row's Date grouped with a column under one local owner", async () => {
  expect(
    await lintDateUnderCast(
      `import {sql} from "drizzle-orm";
import {events} from "./schema";
const operands = {storedAt: events.createdAt, cursorAt: cursor.createdAt};
sql\`\${operands.storedAt} > \${operands.cursorAt}::timestamptz\`;`,
    ),
  ).toEqual([4]);
});

test("allows in-database boundaries, text tokens, cutoffs and columns under a cast", async () => {
  expect(
    await lintDateUnderCast(
      `import {sql,gt} from "drizzle-orm";
import {chatTurns} from "./schema";
const local = pgTable("local", {});
sql\`(\${chatTurns.createdAt}, \${chatTurns.id}) > (select t.created_at, t.id from chat_turns t where t.id = \${turnId})\`;
sql\`(\${chatTurns.createdAt}, \${chatTurns.id}) < (\${pgTimestampCursorBoundary(cursor)}, \${id})\`;
sql\`(\${chatTurns.createdAt}, \${chatTurns.id}) < (\${token}::timestamptz, \${id}::uuid)\`;
sql\`\${chatTurns.createdAt} > \${thread.updatedAtToken}::timestamptz\`;
sql\`\${chatTurns.createdAt} <= \${cutoff.toISOString()}::timestamptz\`;
sql\`\${chatTurns.settledAt} >= \${chatTurns.createdAt}::timestamptz\`;
sql\`\${local.settledAt} >= \${local.createdAt}::timestamptz\`;
const live = (table = session) => sql\`\${table.expiresAt} > \${table.lastSeenAt}::timestamptz\`;
sql\`UPDATE chat_turns SET settled_at = \${row.settledAt}::timestamptz\`;
gt(chatTurns.createdAt, sql\`\${cutoff}::timestamptz\`);
sql\`\${chatTurns.createdAt} > \${row.createdAt}\`;`,
    ),
  ).toEqual([]);
});
