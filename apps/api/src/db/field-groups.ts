import { sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

type FieldsSetTogetherOptions = {
  name: string;
  columns: readonly [AnyPgColumn, AnyPgColumn, ...AnyPgColumn[]];
};

/**
 * One CHECK requiring a group of nullable columns to be set together or
 * cleared together, such as a lease's token, start and expiry.
 */
export const fieldsSetTogetherCheck = ({
  name,
  columns: [first, ...rest],
}: FieldsSetTogetherOptions) =>
  p.check(
    name,
    sql.join(
      rest.map((column) => sql`(${first} IS NULL) = (${column} IS NULL)`),
      sql` AND `,
    ),
  );
