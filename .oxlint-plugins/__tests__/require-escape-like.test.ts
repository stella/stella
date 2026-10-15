import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects interpolated patterns through operator aliases namespaces and const bindings", async () => {
  expect(
    await lintSingleRule(
      "require-escape-like",
      `import { ilike as match, like } from "drizzle-orm";
import * as orm from "drizzle-orm";
const { notIlike: exclude } = orm;
const pattern = \`%\${q}%\`;
match(col, \`%\${q}%\`);
like(col, "%" + q + "%");
exclude(col, pattern);
(0, orm.notLike)(col, \`%\${q}%\`);`,
      { sourcePath: "apps/api/src/handlers/search.ts", cwd: "scratch" },
    ),
  ).toEqual([5, 6, 7, 8]);
});

test("rejects unescaped SQL tag patterns and SQL-side concatenation", async () => {
  expect(
    await lintSingleRule(
      "require-escape-like",
      `import { sql as query } from "drizzle-orm";
query\`\${col} ILIKE \${\`%\${q}%\`}\`;
query\`\${col} LIKE '%' || \${q} || '%'\`;`,
      { sourcePath: "apps/api/src/handlers/search.ts", cwd: "scratch" },
    ),
  ).toEqual([2, 3]);
});

test("accepts canonical escaped patterns including wrapper calls and relative ownership", async () => {
  expect(
    await lintSingleRule(
      "require-escape-like",
      `import { ilike, sql } from "drizzle-orm";
import { escapeLike as escape } from "../lib/escape-like";
const safe = escape(q);
ilike(col, \`%\${safe}%\`);
sql\`\${col} LIKE \${fold(escape(q))} || '%'\`;`,
      { sourcePath: "apps/api/src/handlers/search.ts", cwd: "scratch" },
    ),
  ).toEqual([]);
});

test("does not trust same-named helpers from the wrong module", async () => {
  expect(
    await lintSingleRule(
      "require-escape-like",
      `import { ilike } from "drizzle-orm";
import { escapeLike } from "other-escape";
ilike(col, \`%\${escapeLike(q)}%\`);`,
    ),
  ).toEqual([3]);
});

test("accepts opaque and constant patterns and unrelated operators", async () => {
  expect(
    await lintSingleRule(
      "require-escape-like",
      `import { like } from "drizzle-orm";
import { ilike } from "other-orm";
like(col, pattern);
like(col, "literal%");
ilike(col, \`%\${q}%\`);`,
    ),
  ).toEqual([]);
});

test("still rejects a mixed pattern when only one dynamic input is escaped", async () => {
  expect(
    await lintSingleRule(
      "require-escape-like",
      [
        'import { ilike } from "drizzle-orm";',
        'import { escapeLike } from "@/api/lib/escape-like";',
        `ilike(col, \`%\${escapeLike(q)}\${other}%\`);`,
      ].join("\n"),
      { sourcePath: "apps/api/src/handlers/search.ts", cwd: "scratch" },
    ),
  ).toEqual([3]);
});
