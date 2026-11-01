import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const SOURCE = [
  'import { user } from "@/api/db/auth-schema";',
  "export const read = db.select().from(user);",
  "",
].join("\n");

test("schema metadata does not exempt database reads in the same module", async () => {
  const source = [
    'import { user } from "@/api/db/auth-schema";',
    'import { getTableConfig } from "drizzle-orm/pg-core";',
    "const name = getTableConfig(user).name;",
    'const owner = text("user_id").references(() => user.id);',
    "export const read = db.select().from(user);",
  ].join("\n");
  expect(
    await lintSingleRule("no-unscoped-user-query", source, {
      plugin: "security-guards",
      sourcePath: "apps/api/src/db/schema/account-export-fixture.ts",
    }),
  ).toEqual([5]);
});

const lint = async (
  sourcePath: string,
  allowedFiles?: readonly { file: string; reason: string }[],
) =>
  await lintSingleRule("no-unscoped-user-query", SOURCE, {
    plugin: "security-guards",
    ruleOptions: allowedFiles === undefined ? undefined : { allowedFiles },
    sourcePath,
  });

describe.serial("no-unscoped-user-query allowedFiles", () => {
  test("reports an unscoped read in a module that is not listed", async () => {
    expect(
      await lint("apps/api/src/lib/elsewhere.ts", [
        { file: "apps/api/src/lib/listed.ts", reason: "own account only" },
      ]),
    ).toEqual([2]);
  });

  test("accepts every query in a listed module", async () => {
    expect(
      await lint("apps/api/src/lib/listed.ts", [
        { file: "apps/api/src/lib/listed.ts", reason: "own account only" },
      ]),
    ).toEqual([]);
  });

  test("does not honour an entry without a reason", async () => {
    expect(
      await lint("apps/api/src/lib/listed.ts", [
        { file: "apps/api/src/lib/listed.ts", reason: " " },
      ]),
    ).toEqual([2]);
  });
});

const HISTORICAL_QUERY = `
import { user as account } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
import * as orm from "drizzle-orm";
import { correspondenceFilers as filers, correspondenceAllowedSenders as senders } from "@/api/db/schema";
const filer = tableAlias(account, "filer");
const approver = tableAlias(account, "approver");
export const read = tx.select({ name: filer.name, approver: approver.name })
  .from(filers)
  .leftJoin(senders, orm.eq(filers.filedByAllowedSenderId, senders.id))
  .leftJoin(filer, orm.eq(filers.filedByUserId, filer.id))
  .leftJoin(approver, orm.eq(senders.approvedBy, approver.id))
  .where(orm.and(
    orm.eq(filers.organizationId, session.activeOrganizationId),
    orm.eq(filers.workspaceId, workspaceId),
    orm.eq(filers.correspondenceId, correspondenceId)
  )).limit(100);
`;
const lintHistorical = async (source: string) =>
  await lintSingleRule("no-unscoped-user-query", source, {
    plugin: "security-guards",
    sourcePath: "apps/api/src/handlers/workspaces/correspondence/get.ts",
  });

describe.serial("no-unscoped-user-query historical correspondence", () => {
  test("rejects stored filer and approver joins without current membership scope", async () => {
    expect(await lintHistorical(HISTORICAL_QUERY)).not.toEqual([]);
  });

  test("rejects historical user joins inside Promise.all with an unrelated query", async () => {
    expect(
      await lintHistorical(
        HISTORICAL_QUERY.replace(
          "export const read = tx.select",
          "export const read = Promise.all([tx.select",
        ).replace(
          ")).limit(100);",
          ")).limit(100), tx.select().from(otherTable)]);",
        ),
      ),
    ).not.toEqual([]);
  });
});

const PROFILE_SELECTION = `
import { user, member } from "@/api/db/auth-schema";
const profileColumns = { name: user.name, email: user.email } as const;
type ProfileProjection = typeof profileColumns;
export const scoped = db.select(profileColumns).from(user)
  .innerJoin(member, and(
    eq(member.userId, user.id),
    eq(member.organizationId, session.activeOrganizationId)
  ));
`;

const lintProfileSelection = async (source: string) =>
  await lintSingleRule("no-unscoped-user-query", source, {
    plugin: "security-guards",
    sourcePath: "apps/api/src/handlers/workspaces/member-previews/list.ts",
  });

describe.serial("no-unscoped-user-query hoisted projections", () => {
  test("ignores type-only references when every runtime consumer is scoped", async () => {
    expect(await lintProfileSelection(PROFILE_SELECTION)).toEqual([]);
  });

  test("rejects an unscoped runtime consumer alongside scoped and type-only consumers", async () => {
    expect(
      await lintProfileSelection(
        `${PROFILE_SELECTION}\nexport const unscoped = db.select(profileColumns).from(user);`,
      ),
    ).not.toEqual([]);
  });
});

describe.serial("no-unscoped-user-query schema metadata", () => {
  const options = {
    plugin: "security-guards",
    sourcePath: "apps/api/src/db/schema/receipt.ts",
    cwd: "scratch" as const,
  };
  test("allows foreign-key callbacks while retaining row-query checks", async () => {
    const source = `import { user } from "@/api/db/auth-schema";
export const table = pgTable("receipt", { userId: text("user_id").references(() => user.id) });`;
    expect(
      await lintSingleRule("no-unscoped-user-query", source, options),
    ).toEqual([]);
    expect(
      await lintSingleRule(
        "no-unscoped-user-query",
        `${source}\nexport const rows = db.select().from(user);`,
        options,
      ),
    ).toEqual([3]);
  });
  test("checks row reads and returned columns inside block callbacks", async () => {
    const source = `import { user } from "@/api/db/auth-schema";
export const table = pgTable("receipt", {
  userId: text("user_id").references(() => {
    db.select().from(user);
    return user.id;
  }),
});`;
    expect(
      await lintSingleRule("no-unscoped-user-query", source, options),
    ).toEqual([4, 5]);
  });
  test("checks a block callback that only returns a column", async () => {
    const source = `import { user } from "@/api/db/auth-schema";
export const table = pgTable("receipt", {
  userId: text("user_id").references(() => {
    return user.id;
  }),
});`;
    expect(
      await lintSingleRule("no-unscoped-user-query", source, options),
    ).toEqual([4]);
  });
  test("checks concise callbacks outside the first references argument", async () => {
    const source = `import { user } from "@/api/db/auth-schema";
export const table = pgTable("receipt", { userId: text("user_id").references(options, () => user.id) });`;
    expect(
      await lintSingleRule("no-unscoped-user-query", source, options),
    ).toEqual([2]);
  });
});

describe.serial("no-unscoped-user-query Drizzle aliases", () => {
  const options = {
    plugin: "security-guards",
    sourcePath: "apps/api/src/handlers/workspaces/member-previews/list.ts",
    cwd: "scratch" as const,
  };
  const lintAliasSource = async (source: string) =>
    await lintSingleRule("no-unscoped-user-query", source, options);

  test("does not treat alias construction and column metadata as a row read", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
const accountAlias = tableAlias(account, "account_alias");
export const accountIdColumn = accountAlias.id;`;
    expect(await lintAliasSource(source)).toEqual([]);
  });

  test("accepts a user alias read joined through organization membership", async () => {
    const source = `import { user as account, member } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
import { and, eq } from "drizzle-orm";
const admittedAccount = tableAlias(account, "admitted_account");
export const read = db.select({ email: admittedAccount.email })
  .from(member)
  .innerJoin(admittedAccount, and(
    eq(admittedAccount.id, member.userId),
    eq(member.organizationId, organizationId)
  ));`;
    expect(await lintAliasSource(source)).toEqual([]);
  });

  test("reports a native user alias read without the membership join", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
const admittedAccount = tableAlias(account, "admitted_account");
export const read = db.select().from(admittedAccount);`;
    expect(await lintAliasSource(source)).toEqual([4]);
  });

  test("reports an aliased user column in a query with a raw FROM source", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
const admittedAccount = tableAlias(account, "admitted_account");
export const read = db.select({ email: admittedAccount.email })
  .from(sql.raw('public."user" AS admitted_account'));`;
    expect(await lintAliasSource(source)).toEqual([5]);
  });

  test("follows a stable projection into a raw FROM query", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
const admittedAccount = tableAlias(account, "admitted_account");
const projection = { email: admittedAccount.email };
export const read = db.select(projection)
  .from(sql.raw('public."user" AS admitted_account'));`;
    expect(await lintAliasSource(source)).toEqual([6]);
  });

  test("checks every query consuming a hoisted alias projection", async () => {
    const source = `import { user as account, member } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
import { and, eq, sql } from "drizzle-orm";
const admittedAccount = tableAlias(account, "admitted_account");
const projection = { email: admittedAccount.email };
export const scoped = db.select(projection)
  .from(member)
  .innerJoin(admittedAccount, and(
    eq(admittedAccount.id, member.userId),
    eq(member.organizationId, organizationId)
  ));
export const unscoped = db.select(projection).from(sql.raw('public."user" AS admitted_account'));`;
    expect(await lintAliasSource(source)).toEqual([12]);
  });

  test("keeps a projected alias column without a query as metadata", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
const admittedAccount = tableAlias(account, "admitted_account");
export const projection = { email: admittedAccount.email };`;
    expect(await lintAliasSource(source)).toEqual([]);
  });

  test("reports aliased user columns in a raw SQL row query", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
const admittedAccount = tableAlias(account, "admitted_account");
export const read = db.execute(sql\`SELECT \${admittedAccount.email} FROM public."user" AS admitted_account\`);`;
    expect(await lintAliasSource(source)).toEqual([5]);
  });

  test("follows a query receiver through a stable local into an unscoped read", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";
const admittedAccount = tableAlias(account, "admitted_account");
const query = db.select().from(sql.raw('public."user" AS admitted_account'));
export const read = query.where(eq(admittedAccount.email, email));`;
    expect(await lintAliasSource(source)).toEqual([6]);
  });

  test("treats an opaque column reader as a possible user row read", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
const admittedAccount = tableAlias(account, "admitted_account");
export const read = readColumn(admittedAccount.email);`;
    expect(await lintAliasSource(source)).toEqual([4]);
  });

  test("does not require an organization predicate for a member-only alias read", async () => {
    const source = `import { member as membership } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
const membershipAlias = tableAlias(membership, "membership_alias");
export const read = db.select({ userId: membershipAlias.userId })
  .from(membershipAlias);`;
    expect(await lintAliasSource(source)).toEqual([]);
  });

  test("does not accept another table aliased as member as membership proof", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { featureEnrolments } from "@/api/db/schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
import { and, eq } from "drizzle-orm";
const falseMember = tableAlias(featureEnrolments, "member");
export const read = db.select({ email: account.email })
  .from(account)
  .innerJoin(falseMember, and(
    eq(account.id, falseMember.userId),
    eq(falseMember.organizationId, organizationId)
  ));`;
    expect(await lintAliasSource(source)).not.toEqual([]);
  });

  test("does not identify another table as user because of its SQL alias", async () => {
    const source = `import { member } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
const user = tableAlias(member, "user");
export const read = db.select().from(user);`;
    expect(await lintAliasSource(source)).toEqual([]);
  });

  test("does not trust an alias function imported from another module", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { alias as tableAlias } from "./local-table-helper";
const accountAlias = tableAlias(account, "account_alias");
export const read = db.select().from(accountAlias);`;
    expect(await lintAliasSource(source)).not.toEqual([]);
  });

  test("does not trust a shadowed local alias factory", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
const tableAlias = (table: unknown, name: string) => ({ table, name });
const accountAlias = tableAlias(account, "account_alias");
export const read = db.select().from(accountAlias);`;
    expect(await lintAliasSource(source)).not.toEqual([]);
  });

  test("does not trust an imported alias shadowed by a function parameter", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { alias } from "drizzle-orm/pg-core";
const makeRead = (alias: (table: unknown, name: string) => unknown) => {
  const accountAlias = alias(account, "account_alias");
  return db.select().from(accountAlias);
};
export const read = makeRead((table) => table);`;
    expect(await lintAliasSource(source)).not.toEqual([]);
  });

  test("does not trust a nonliteral alias name", async () => {
    const source = `import { user as account } from "@/api/db/auth-schema";
import { alias as tableAlias } from "drizzle-orm/pg-core";
const accountAlias = tableAlias(account, aliasName);
export const read = db.select().from(accountAlias);`;
    expect(await lintAliasSource(source)).not.toEqual([]);
  });
});
