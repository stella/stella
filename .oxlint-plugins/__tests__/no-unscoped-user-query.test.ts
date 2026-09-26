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
  test("accepts stored filer and approver relationships after current membership ends", async () => {
    expect(await lintHistorical(HISTORICAL_QUERY)).toEqual([]);
  });

  test.each(["organizationId", "workspaceId", "correspondenceId"])(
    "requires the %s predicate",
    async (column) => {
      expect(
        await lintHistorical(
          HISTORICAL_QUERY.replace(
            `orm.eq(filers.${column},`,
            () => `orm.eq(unrelated.${column},`,
          ),
        ),
      ).not.toEqual([]);
    },
  );

  test.each([
    ["filer actor", "filers.filedByUserId, filer.id", "attackerId, filer.id"],
    [
      "approver actor",
      "senders.approvedBy, approver.id",
      "attackerId, approver.id",
    ],
    [
      "approved mailbox",
      "filers.filedByAllowedSenderId, senders.id",
      "attackerId, senders.id",
    ],
    ["mandatory scope", ".where(orm.and(", ".where(orm.or("],
    [
      "overwritten scope",
      ")).limit(100);",
      ")).$dynamic().where(orm.eq(filers.organizationId, attackerOrg)).limit(100);",
    ],
    [
      "table origin",
      "correspondenceFilers as filers",
      "unrelatedTable as filers",
    ],
    [
      "predicate origin",
      'import * as orm from "drizzle-orm";',
      'import * as orm from "untrusted-orm";',
    ],
  ])("rejects missing or forged %s", async (_label, before, after) => {
    expect(
      await lintHistorical(HISTORICAL_QUERY.replace(before, () => after)),
    ).not.toEqual([]);
  });

  test("does not authorize an unrelated user read beside the historical query", async () => {
    expect(
      await lintHistorical(
        `${HISTORICAL_QUERY.replace(
          "export const read = tx.select",
          "const historical = tx.select",
        )}\nexport const read = Promise.all([historical, tx.select().from(account)]);\n`,
      ),
    ).not.toEqual([]);
  });

  test("does not confuse distinct user aliases or a shadowed table parameter", async () => {
    expect(
      await lintHistorical(
        HISTORICAL_QUERY.replace(
          "filers.filedByUserId, filer.id",
          "filers.filedByUserId, approver.id",
        ),
      ),
    ).not.toEqual([]);
    expect(
      await lintHistorical(
        HISTORICAL_QUERY.replace(
          "export const read = tx.select",
          "export const read = (filers) => tx.select",
        ),
      ),
    ).not.toEqual([]);
  });

  test("accepts the historical query inside Promise.all with an unrelated non-user query", async () => {
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
    ).toEqual([]);
  });
});
