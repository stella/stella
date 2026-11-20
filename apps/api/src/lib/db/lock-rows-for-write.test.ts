import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";

import { rejectionOf } from "@stll/property-testing/rejection";

import { timeEntries, workspaces } from "@/api/db/schema";

import { lockRowsForWrite } from "./aggregate-lock";

// `where()` names rows by the locked table's id, so both checks run before
// any lock is taken; a database that answers nothing is enough.
const database = drizzle(async () => await Promise.resolve({ rows: [] }));

describe("locking rows for a write", () => {
  test("accepts the locked table's own id and locks only what it read", async () => {
    const query = database
      .select({ id: timeEntries.id })
      .from(timeEntries)
      .innerJoin(workspaces, eq(workspaces.id, timeEntries.workspaceId));
    const locked = await lockRowsForWrite({ table: timeEntries, query });
    expect(locked.ids).toEqual([]);
  });

  test("refuses an id projected from a joined table", async () => {
    const query = database
      .select({ id: workspaces.id })
      .from(timeEntries)
      .innerJoin(workspaces, eq(workspaces.id, timeEntries.workspaceId));
    expect(
      await rejectionOf(
        // @ts-expect-error -- a joined table's id is not the locked table's id
        lockRowsForWrite({ table: timeEntries, query }),
      ),
    ).toMatchObject({
      message: "Locked rows must project the locked table's own id column",
    });
  });

  test("refuses rows read from another table", async () => {
    const query = database
      .select({ id: timeEntries.id })
      .from(workspaces)
      .innerJoin(timeEntries, eq(workspaces.id, timeEntries.workspaceId));
    expect(
      await rejectionOf(lockRowsForWrite({ table: timeEntries, query })),
    ).toMatchObject({
      message: "Locked rows must be read from the table they are written to",
    });
  });
});
