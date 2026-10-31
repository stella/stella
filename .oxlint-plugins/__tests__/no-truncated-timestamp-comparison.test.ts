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
