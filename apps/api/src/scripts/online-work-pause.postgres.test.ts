import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { ONLINE_WORK_NAMES } from "@/api/db/online-migrations";
import { ONLINE_WORK_LIFECYCLE } from "@/api/db/online-work-lifecycle";
import { readOnlineWorkPause } from "@/api/db/online-work-pause";
import { onlineWorkState } from "@/api/db/schema/online-work-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  parseOnlineWorkPauseArgs,
  runOnlineWorkPause,
} from "./online-work-pause";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];
const name =
  ONLINE_WORK_NAMES.find(
    (candidate) => ONLINE_WORK_LIFECYCLE[candidate].state === "pending",
  ) ?? panic("Expected pending work");

const command = (action: "pause" | "resume", apply = true) =>
  parseOnlineWorkPauseArgs([
    action,
    "--step",
    name,
    ...(action === "pause" ? ["--for", "1h"] : []),
    "--actor",
    "test-operator",
    "--reason",
    "Maintenance test window",
    ...(apply ? ["--apply"] : []),
  ]);

describe.skipIf(!enabled)("online step operator pauses on Postgres", () => {
  test("dry-run, pause, renewal, legacy fencing, attribution and resume are durable", async () => {
    if (databaseUrl === undefined) {
      return panic("DATABASE_URL is required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      await db.delete(onlineWorkState).where(eq(onlineWorkState.name, name));
      const read = async () =>
        (
          await db
            .select()
            .from(onlineWorkState)
            .where(eq(onlineWorkState.name, name))
        ).at(0);
      const write = () => undefined;
      try {
        await runOnlineWorkPause(command("pause", false), { db, write });
        expect(await read()).toBeUndefined();
        await runOnlineWorkPause(command("pause"), { db, write });
        const paused = await read();
        expect(paused).toMatchObject({
          state: "paused",
          pausedBy: "test-operator",
          pauseReason: "Maintenance test window",
        });
        expect(paused?.pausedSince).toBeInstanceOf(Date);
        expect(await readOnlineWorkPause(db, name)).toBe(true);
        await runOnlineWorkPause(command("pause"), { db, write });
        expect((await read())?.pausedSince).toEqual(paused?.pausedSince);
        const legacyClaim = await Result.tryPromise(
          async () =>
            await db.execute(
              sql`UPDATE online_work_state SET state = 'building' WHERE name = ${name}`,
            ),
        );
        expect(legacyClaim.isErr()).toBe(true);
        expect((await read())?.state).toBe("paused");
        await db.execute(
          sql`UPDATE online_work_state SET state = 'finalized' WHERE name = ${name}`,
        );
        expect((await read())?.state).toBe("paused");
        const unbounded = await Result.tryPromise(
          async () =>
            await db.execute(
              sql`UPDATE online_work_state SET paused_until = now() + interval '73 hours' WHERE name = ${name}`,
            ),
        );
        expect(unbounded.isErr()).toBe(true);
        await runOnlineWorkPause(command("resume"), { db, write });
        expect(await readOnlineWorkPause(db, name)).toBe(false);
        expect(await read()).toMatchObject({
          state: "pending",
          pausedUntil: null,
          pausedSince: null,
          pausedBy: "test-operator",
        });
      } finally {
        await db.delete(onlineWorkState).where(eq(onlineWorkState.name, name));
      }
    });
  });
});
