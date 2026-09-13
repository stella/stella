import { panic } from "better-result";

import { isRecord } from "@/api/lib/type-guards";

/**
 * What a fake `tx` must answer when `insertEntityVersions` inserts.
 *
 * The writer names the verification-code index as its only conflict arbiter
 * and reads RETURNING to learn which rows landed, so a mock that echoes
 * nothing reads as "every row lost a code collision" and sends the writer
 * around its retry loop. Echo the ids it was handed instead.
 */
export const entityVersionInsertResult = (values: unknown) => ({
  onConflictDoNothing: () => ({
    returning: () =>
      (Array.isArray(values) ? values : [values]).map((row: unknown) =>
        isRecord(row)
          ? { id: row["id"] }
          : panic("Entity-version insert fixture is not a row object"),
      ),
  }),
});
