import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sharedTestDatabase } from "@stll/scripts/src/shared-test-postgres";

import { withGatedTestClients } from "../src/tests/gated-test-database";

describe.skipIf(process.env["STELLA_RUN_SHARED_POSTGRES_TESTS"] !== "true")(
  "shared test Postgres lifecycle",
  () => {
    test("concurrent workers migrate isolated databases and cleanup is idempotent", async () => {
      const repo = path.resolve(import.meta.dir, "../../..");
      const trees = [
        mkdtempSync(path.join(tmpdir(), "stella-pg-a-")),
        mkdtempSync(path.join(tmpdir(), "stella-pg-b-")),
      ];
      const command = async (tree: string, action: string) => {
        const child = Bun.spawn(
          [
            "bash",
            path.join(repo, "scripts/shared-test-postgres.sh"),
            action,
            "--tree",
            tree,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const output = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        return output;
      };
      try {
        for (const tree of trees) {
          mkdirSync(path.join(tree, "apps"));
          symlinkSync(path.join(repo, "apps/api"), path.join(tree, "apps/api"));
        }
        const outputs = await Promise.all(
          trees.map(async (tree) => command(tree, "prepare")),
        );
        const urls = outputs.map((output) => {
          const payload: unknown = JSON.parse(output);
          if (
            typeof payload !== "object" ||
            payload === null ||
            !("urlFile" in payload) ||
            typeof payload.urlFile !== "string"
          ) {
            throw new TypeError("Invalid prepare response");
          }
          const url = new URL(readFileSync(payload.urlFile, "utf-8"));
          expect(url.username).toBe("stella_test_owner");
          return url.toString();
        });
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
                sharedTestDatabase(realpathSync(trees[index] ?? "missing")),
              );
              expect(posture.at(0)?.["rolsuper"]).toBe(false);
              expect(posture.at(0)?.["rolbypassrls"]).toBe(false);
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
        await Promise.all(trees.map(async (tree) => command(tree, "drop")));
        await Promise.all(trees.map(async (tree) => command(tree, "drop")));
        const observerUrl = new URL(
          urls.at(0) ?? panic("Missing observer URL"),
        );
        observerUrl.pathname = "/postgres";
        await withGatedTestClients(
          observerUrl.toString(),
          async ({ openClient }) => {
            const { sql } = openClient();
            for (const tree of trees) {
              expect(
                await sql`SELECT datname FROM pg_database WHERE datname = ${sharedTestDatabase(realpathSync(tree))}`,
              ).toHaveLength(0);
            }
          },
        );
      } finally {
        await Promise.all(trees.map(async (tree) => command(tree, "drop")));
        for (const tree of trees) {
          rmSync(tree, { recursive: true, force: true });
        }
      }
    }, 300_000);
  },
);
