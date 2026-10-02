import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const SOURCE = [
  'import { user } from "@/api/db/auth-schema";',
  "export const read = db.select().from(user);",
  "",
].join("\n");

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
