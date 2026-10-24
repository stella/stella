import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  censusOnlineDdlSource,
  TEMPLATE_INTERPOLATION_ALLOWLIST,
} from "./online-ddl-lock-census";

const ownerSource = readFileSync(
  path.resolve(import.meta.dir, "../apps/api/src/db/online-ddl.ts"),
  "utf-8",
);

describe("online DDL lock census", () => {
  test("the interpolation allowlist remains explicit and counted", () => {
    expect(
      TEMPLATE_INTERPOLATION_ALLOWLIST.map(({ shape, reason }) => ({
        shape,
        reason,
      })),
    ).toEqual([
      {
        shape: "quoteIdentifier(...) call",
        reason:
          "quoteIdentifier returns one validated, double-quoted PostgreSQL identifier.",
      },
      {
        shape: "conditional with literal-only branches",
        reason:
          "Literal branches are enumerated independently and cannot inject uninspected SQL.",
      },
    ]);
  });

  test("the online DDL owner classifies each gated SQL variant", () => {
    expect(censusOnlineDdlSource(ownerSource)).toEqual([]);
  });

  test.each([
    ["const createSqlTarget", "export const createSqlTarget"],
    ["const match =", "const /* target proof */ match ="],
  ])("constant declarations retain their AST proof: %s", (before, after) => {
    const source = ownerSource.replace(before, () => after);
    expect(source).not.toBe(ownerSource);
    expect(censusOnlineDdlSource(source)).toEqual([]);
  });

  test.each([
    ["const createSqlTarget", "let createSqlTarget"],
    ["const createSqlTarget", "var createSqlTarget"],
    ["const match =", "let match ="],
    ["const match =", "var match ="],
  ])(
    "mutable declarations cannot supply the concurrent proof: %s",
    (before, after) => {
      const source = ownerSource.replace(before, () => after);
      expect(source).not.toBe(ownerSource);
      expect(censusOnlineDdlSource(source)).toContain(
        "createSql pass-through lacks an anchored concurrent-index AST proof",
      );
    },
  );

  test("a dormant constant declaration cannot supply the concurrent proof", () => {
    const source = ownerSource.replace(
      /const createSqlTarget =[\s\S]*?;/u,
      (declaration) => `if (false) {\n${declaration}\n}`,
    );
    expect(source).not.toBe(ownerSource);
    expect(censusOnlineDdlSource(source)).toContain(
      "createSql pass-through lacks an anchored concurrent-index AST proof",
    );
  });

  test("unknown DDL in a gated SQL template fails the census", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking({ tableName: "probe", lockQueue: "blocks_writers", text: \`CREATE MATERIALIZED VIEW probe_view AS SELECT 1\` });`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /unknown|unclassified|unsupported/iu,
    );
  });

  test("an ungated ACCESS EXCLUSIVE table alteration fails the census", () => {
    const source = `${ownerSource}\nconst fixture = \`ALTER TABLE public.probe ADD COLUMN added text\`;`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /ACCESS EXCLUSIVE.*lockTaking/iu,
    );
  });

  test.each([
    ["SHARE", "CREATE INDEX probe_idx ON public.probe (id)"],
    [
      "SHARE ROW EXCLUSIVE",
      "LOCK TABLE public.probe IN SHARE ROW EXCLUSIVE MODE",
    ],
    ["ACCESS EXCLUSIVE", "ALTER TABLE public.probe ADD COLUMN added text"],
  ] as const)("ungated %s SQL requires the branded path", (mode, sql) => {
    const source = `${ownerSource}\nconst fixture = ${JSON.stringify(sql)};`;
    expect(censusOnlineDdlSource(source).join("\n")).toContain(mode);
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /must be passed through lockTaking/iu,
    );
  });

  test("the dynamic create SQL exception is scoped to its checked builder", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking({ tableName: "probe", lockQueue: "blocks_writers", text: createSql });`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /createSql pass-through lacks an anchored concurrent-index AST proof/iu,
    );
  });

  test("every lock-taking conditional branch must resolve to literal SQL", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking({ tableName: "probe", lockQueue: "blocks_writers", text: condition ? "ALTER TABLE probe ADD COLUMN added text" : suppliedSql });`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /lockTaking SQL argument .* unresolved SQL variant/iu,
    );
  });

  test("a template substitution is unresolved even when its value could contain SQL", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking({ tableName: "probe", lockQueue: "blocks_writers", text: \`ALTER TABLE probe ADD COLUMN added text \${suppliedSql}\` });`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /lockTaking SQL argument .* unresolved SQL variant/iu,
    );
  });

  test("a raw string interpolation is unresolved", () => {
    const source = `${ownerSource}\nconst rawSql = "NOT NULL; DROP TABLE probe";\nconst fixture = lockTaking({ tableName: "probe", lockQueue: "blocks_writers", text: \`ALTER TABLE probe ADD COLUMN added text \${rawSql}\` });`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /lockTaking SQL argument .* unresolved SQL variant/iu,
    );
  });

  test.each([
    ", ADD COLUMN added text",
    ", ADD CONSTRAINT extra_check CHECK (true) NOT VALID",
  ])("spliced ALTER actions stay unresolved: %s", (extra) => {
    const source = `${ownerSource}\nconst extra = ${JSON.stringify(extra)};\nconst fixture = lockTaking({ tableName: "probe", lockQueue: "beside_writers", text: \`ALTER TABLE probe VALIDATE CONSTRAINT probe_check \${spliced(extra)}\` });`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /lockTaking SQL argument .* unresolved SQL variant/iu,
    );
  });

  test("policy expression placeholders require the owner's enclosing expression structure", () => {
    const source = ownerSource.replace(
      ` USING (\${spliced(using)})`,
      ` \${spliced(using)}`,
    );
    expect(source).not.toBe(ownerSource);
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /unresolved SQL variant/iu,
    );
  });

  test("the quoted-identifier interpolation allowance resolves", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking({ tableName: "probe", lockQueue: "blocks_writers", text: \`ANALYZE public.\${quoteIdentifier(tableName)}\` });`;
    expect(censusOnlineDdlSource(source)).toEqual([]);
  });

  test("the literal-branch interpolation allowance resolves every branch", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking({ tableName: "probe", lockQueue: "blocks_writers", text: \`DROP INDEX CONCURRENTLY \${ifExists ? "IF EXISTS " : ""}public.probe_idx\` });`;
    expect(censusOnlineDdlSource(source)).toEqual([]);
  });

  test("a fully literal lock-taking conditional classifies every branch", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking({ tableName: "probe", lockQueue: "blocks_writers", text: condition ? "ALTER TABLE probe ADD COLUMN first text" : "ALTER TABLE probe ADD COLUMN second text" });`;
    expect(censusOnlineDdlSource(source)).toEqual([]);
  });

  test("every resolved lock-taking conditional branch must be classified", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking({ tableName: "probe", lockQueue: "blocks_writers", text: condition ? "ALTER TABLE probe ADD COLUMN added text" : "SELECT 1; CREATE MATERIALIZED VIEW hidden AS SELECT 1;" });`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /unclassified SQL statement: SELECT 1/iu,
    );
  });

  test("every statement in a lock-taking literal must be classified", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking({ tableName: "probe", lockQueue: "blocks_writers", text: "ALTER TABLE probe ADD COLUMN first text; ALTER TABLE probe ADD COLUMN second text;" });`;
    expect(censusOnlineDdlSource(source)).toEqual([]);
  });

  test("the private statement brand cannot be manufactured with a cast", () => {
    const source = `${ownerSource}\nconst counterfeit = {} as LockTakingStatement;`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /LockTakingStatement must be constructed by lockTaking/iu,
    );
  });

  test("table sessions cannot be constructed outside the approved gates", () => {
    const source = `${ownerSource}\nconst fixture = sessionOn({ connection, target, lockRetry, onRetry: () => undefined }).run(async () => {});`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /sessionOn .* is outside runGatedTableWork or createUngatedTableGateForTests/iu,
    );
  });

  test("gated table work must use the connection passed to runtime.attempt", () => {
    const source = ownerSource.replace(
      "connection: guardedConnection,",
      "connection,",
    );
    expect(source).not.toBe(ownerSource);
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /sessionOn .* must use the guarded runtime\.attempt connection/iu,
    );
  });
  test.each([
    "connection: guardedConnection, ...supplied,",
    "connection: guardedConnection, connection,",
  ])(
    "table session options cannot replace the guarded connection: %s",
    (replacement) => {
      const source = ownerSource.replace(
        "connection: guardedConnection,",
        () => replacement,
      );
      expect(source).not.toBe(ownerSource);
      expect(censusOnlineDdlSource(source).join("\n")).toMatch(
        /sessionOn .* must use the guarded runtime\.attempt connection/iu,
      );
    },
  );
  test("writer-blocking SQL cannot use the beside-writers queue", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking({ tableName: "probe", text: "ALTER TABLE probe ADD COLUMN added text", lockQueue: "beside_writers" });`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /must use blocks_writers/iu,
    );
  });

  test("a block cannot hide an unresolved statement array", () => {
    const source = `${ownerSource}\nconst fixture = accessExclusive(tableName, suppliedStatements);`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /literal statement array/iu,
    );
  });

  test.each([
    ['text.includes(";") || text.includes(BLOCK_TAG)', 'text.includes(";")'],
    ['lockQueue: "blocks_writers",', 'lockQueue: "beside_writers",'],
    ["const builtTable = match?.at(2);", "const builtTable = match?.at(1);"],
    ["text: spliced(createSql),", "text: createSql,"],
    ['mode: "enable" | "force",', "mode: string,"],
    ["if (!declaration.online)", "if (false)"],
    [`return \`"\${identifier}"\`;`, "return identifier;"],
  ])("the owner proof rejects weakened SQL boundaries: %s", (before, after) => {
    const source = ownerSource.replace(before, () => after);
    expect(source).not.toBe(ownerSource);
    expect(censusOnlineDdlSource(source).length).toBeGreaterThan(0);
  });

  test.each(["if (false)", "if (enabled)", "const unused = () =>"])(
    "the concurrent target guard must execute before building SQL: %s",
    (wrapper) => {
      const guard =
        / {2}if \(builtName !== name \|\| builtTable !== tableName\) \{[\s\S]*?\n {2}\}/u
          .exec(ownerSource)
          ?.at(0) ?? panic("Missing concurrent-index target guard");
      const source = ownerSource.replace(
        guard,
        () => `${wrapper} {\n${guard}\n}`,
      );
      expect(source).not.toBe(ownerSource);
      expect(censusOnlineDdlSource(source)).toContain(
        "createSql pass-through lacks an anchored concurrent-index AST proof",
      );
    },
  );

  test("a private policy SQL builder cannot escape the branded execution path", () => {
    const source = `${ownerSource}\nconst escaped = createPolicyText(policy);`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /ACCESS EXCLUSIVE.*lockTaking/iu,
    );
  });
  test("an ungated anonymous block cannot hide writer-blocking DDL", () => {
    const source = `${ownerSource}\nconst fixture = \`DO $$ BEGIN ALTER TABLE public.probe ADD COLUMN added text; END $$\`;`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /ACCESS EXCLUSIVE.*lockTaking/iu,
    );
  });
});
