import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  sharedTestDatabase,
  sharedTestMigrationHistory,
} from "@stll/scripts/src/shared-test-postgres";

import { withGatedTestClients } from "../src/tests/gated-test-database";

describe.skipIf(process.env["STELLA_RUN_SHARED_POSTGRES_TESTS"] !== "true")(
  "shared test Postgres lifecycle",
  () => {
    test("worker migration histories share matching templates and preserve isolated schemas", async () => {
      const repo = path.resolve(import.meta.dir, "../../..");
      const canonical = mkdtempSync(
        path.join(tmpdir(), "stella-pg-canonical-"),
      );
      const trees = [
        mkdtempSync(path.join(tmpdir(), "stella-pg-a-")),
        mkdtempSync(path.join(tmpdir(), "stella-pg-b-")),
        mkdtempSync(path.join(tmpdir(), "stella-pg-newer-")),
      ];
      const command = async (tree: string, action: string) => {
        const child = Bun.spawn(
          [
            "bash",
            path.join(canonical, "scripts/shared-test-postgres.sh"),
            action,
            "--tree",
            tree,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [output, error, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ exitCode, error }).toEqual({ exitCode: 0, error: "" });
        return output;
      };
      try {
        for (const relative of [
          "scripts/shared-test-postgres.sh",
          "packages/scripts/src/shared-test-postgres.ts",
          "packages/scripts/src/dev-postgres-lock.ts",
          "packages/scripts/src/dev-docker.ts",
          "packages/scripts/src/generation-lock.ts",
        ]) {
          const target = path.join(canonical, relative);
          mkdirSync(path.dirname(target), { recursive: true });
          cpSync(path.join(repo, relative), target);
        }
        symlinkSync(
          path.join(repo, "node_modules"),
          path.join(canonical, "node_modules"),
        );
        symlinkSync(
          path.join(repo, "packages/scripts/node_modules"),
          path.join(canonical, "packages/scripts/node_modules"),
        );
        const entrypoint = "apps/api/scripts/migrate-shared-test-template.ts";
        mkdirSync(path.join(canonical, "apps/api/scripts"), {
          recursive: true,
        });
        symlinkSync(
          path.join(repo, entrypoint),
          path.join(canonical, entrypoint),
        );
        mkdirSync(path.join(canonical, "docker"));
        cpSync(
          path.join(repo, "docker/postgres"),
          path.join(canonical, "docker/postgres"),
          { recursive: true },
        );
        cpSync(
          path.join(repo, "apps/api/drizzle"),
          path.join(canonical, "apps/api/drizzle"),
          { recursive: true },
        );
        // Fresh history keys keep cached templates from hiding a wrong-folder migration.
        const commonFixture = path.join(
          canonical,
          "apps/api/drizzle/20980101000000_shared_history_fixture",
        );
        mkdirSync(commonFixture);
        writeFileSync(
          path.join(commonFixture, "migration.sql"),
          `SELECT 1; -- ${path.basename(canonical)}\n`,
        );
        const fixture = path.join(
          canonical,
          "apps/api/drizzle/20990101000000_worker_migration_fixture",
        );
        mkdirSync(fixture);
        writeFileSync(
          path.join(fixture, "migration.sql"),
          "CREATE TABLE public.shared_worker_migration_fixture (id integer);\n",
        );
        for (const [index, tree] of trees.entries()) {
          mkdirSync(path.join(tree, "apps/api"), { recursive: true });
          cpSync(
            path.join(index === 2 ? canonical : repo, "apps/api/drizzle"),
            path.join(tree, "apps/api/drizzle"),
            { recursive: true },
          );
          cpSync(
            commonFixture,
            path.join(tree, "apps/api/drizzle", path.basename(commonFixture)),
            { recursive: true },
          );
        }
        const newer = trees.at(2) ?? panic("Missing newer worker");
        const canonicalHistory = sharedTestMigrationHistory(canonical).key;
        for (const tree of trees.slice(0, 2)) {
          expect(sharedTestMigrationHistory(tree).key).not.toBe(
            canonicalHistory,
          );
        }
        expect(sharedTestMigrationHistory(newer).key).toBe(canonicalHistory);
        const outputs = await Promise.all(
          trees.map(async (tree) => command(tree, "prepare")),
        );
        const prepared = outputs.map((output) => {
          const payload: unknown = JSON.parse(output);
          if (
            typeof payload !== "object" ||
            payload === null ||
            !("urlFile" in payload) ||
            typeof payload.urlFile !== "string" ||
            !("template" in payload) ||
            typeof payload.template !== "string"
          ) {
            throw new TypeError("Invalid prepare response");
          }
          const url = new URL(readFileSync(payload.urlFile, "utf-8"));
          expect(url.username).toBe("stella_test_owner");
          return { url: url.toString(), template: payload.template };
        });
        expect(prepared.at(0)?.template).toBe(prepared.at(1)?.template);
        expect(prepared.at(2)?.template).not.toBe(prepared.at(0)?.template);
        const urls = prepared.map(({ url }) => url);
        await withGatedTestClients(
          urls.at(0) ?? panic("Missing first worker URL"),
          async ({ openClient }) => {
            const clients = urls.map(
              (databaseUrl) => openClient({ databaseUrl }).sql,
            );
            for (const [index, client] of clients.entries()) {
              const posture =
                await client`SELECT current_database() AS database, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
              expect(posture.at(0)?.["database"]).toBe(
                sharedTestDatabase(
                  realpathSync(trees.at(index) ?? panic("Missing worker tree")),
                ),
              );
              expect(posture.at(0)?.["rolsuper"]).toBe(false);
              expect(posture.at(0)?.["rolbypassrls"]).toBe(false);
              const workerFixture =
                await client`SELECT to_regclass('public.shared_worker_migration_fixture') AS relation`;
              expect(workerFixture.at(0)?.["relation"]).toBe(
                index === 2 ? "shared_worker_migration_fixture" : null,
              );
              await client`CREATE TABLE public.shared_postgres_isolation (value integer)`;
              await client`INSERT INTO public.shared_postgres_isolation VALUES (${index})`;
            }
            for (const [index, client] of clients.entries()) {
              expect(
                (
                  await client`SELECT value FROM public.shared_postgres_isolation`
                ).at(0)?.["value"],
              ).toBe(index);
            }
          },
        );
        const activeTemplate =
          prepared.at(0)?.template ?? panic("Missing active history template");
        const observerUrl = new URL(
          urls.at(0) ?? panic("Missing observer URL"),
        );
        observerUrl.pathname = "/postgres";
        await withGatedTestClients(
          observerUrl.toString(),
          async ({ openClient }) => {
            const { sql } = openClient();
            const aged =
              await sql`UPDATE stella_shared_test.templates SET unused_since = now() - interval '2 days' WHERE template_name = ${activeTemplate} RETURNING unused_since < now() - interval '1 day' AS aged`;
            expect(aged.at(0)?.["aged"]).toBe(true);
            await command(trees.at(0) ?? panic("Missing GC worker"), "gc");
            expect(
              await sql`SELECT datname FROM pg_database WHERE datname = ${activeTemplate}`,
            ).toHaveLength(1);
            const registry =
              await sql`SELECT unused_since FROM stella_shared_test.templates WHERE template_name = ${activeTemplate}`;
            expect(registry).toHaveLength(1);
            expect(registry.at(0)?.["unused_since"]).toBe(null);
          },
        );
        await Promise.all(trees.map(async (tree) => command(tree, "drop")));
        await Promise.all(trees.map(async (tree) => command(tree, "drop")));
        await withGatedTestClients(
          observerUrl.toString(),
          async ({ openClient }) => {
            const { sql } = openClient();
            for (const tree of trees) {
              expect(
                await sql`SELECT datname FROM pg_database WHERE datname = ${sharedTestDatabase(realpathSync(tree))}`,
              ).toHaveLength(0);
            }
            const templates = new Set(prepared.map(({ template }) => template));
            for (const template of templates) {
              const aged =
                await sql`UPDATE stella_shared_test.templates SET unused_since = now() - interval '2 days' WHERE template_name = ${template} RETURNING unused_since < now() - interval '1 day' AS aged`;
              expect(aged.at(0)?.["aged"]).toBe(true);
            }
            await command(trees.at(0) ?? panic("Missing GC worker"), "gc");
            for (const template of templates) {
              expect(
                await sql`SELECT datname FROM pg_database WHERE datname = ${template}`,
              ).toHaveLength(0);
              expect(
                await sql`SELECT template_name FROM stella_shared_test.templates WHERE template_name = ${template}`,
              ).toHaveLength(0);
            }
          },
        );
      } finally {
        await Promise.all(trees.map(async (tree) => command(tree, "drop")));
        for (const tree of [...trees, canonical]) {
          rmSync(tree, { recursive: true, force: true });
        }
      }
    }, 300_000);
  },
);
