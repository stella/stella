import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects aliased and namespace auth table deletion", async () => {
  expect(
    await lintSingleRule(
      "no-direct-auth-artifact-delete",
      `import {session as sessions} from "@/api/db/auth-schema";
import * as schema from "@/api/db/auth-schema";
db.delete(sessions);
db.delete(schema.oauthRefreshToken);`,
      {
        plugin: "auth-lifecycle",
        sourcePath: "apps/api/src/handlers/remove.ts",
      },
    ),
  ).toEqual([3, 4]);
});

test("allows the exact artifact lifecycle owner", async () => {
  expect(
    await lintSingleRule(
      "no-direct-auth-artifact-delete",
      `import {session} from "@/api/db/auth-schema";
db.delete(session);`,
      {
        sourcePath: "apps/api/src/lib/auth-artifacts.ts",
        plugin: "auth-lifecycle",
      },
    ),
  ).toEqual([]);
});

test("does not exempt a same-basename foreign owner", async () => {
  expect(
    await lintSingleRule(
      "no-direct-auth-artifact-delete",
      `import {session} from "@/api/db/auth-schema";
db.delete(session);`,
      {
        sourcePath: "apps/api/src/handlers/auth-artifacts.ts",
        plugin: "auth-lifecycle",
      },
    ),
  ).toEqual([2]);
});

test("ignores unrelated tables and a shadowed table binding", async () => {
  expect(
    await lintSingleRule(
      "no-direct-auth-artifact-delete",
      `import {session} from "@/api/db/auth-schema";
function remove(session:unknown) { db.delete(session); }
db.delete(otherTable);`,
      {
        plugin: "auth-lifecycle",
        sourcePath: "apps/api/src/handlers/remove.ts",
      },
    ),
  ).toEqual([]);
});

test("recognizes the application-local auth schema alias", async () => {
  expect(
    await lintSingleRule(
      "no-direct-auth-artifact-delete",
      `import {session as sessions} from "@/db/auth-schema";
db.delete(sessions);`,
      {
        plugin: "auth-lifecycle",
        sourcePath: "apps/api/src/handlers/remove.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([2]);
});
