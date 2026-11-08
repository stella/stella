import { sql } from "drizzle-orm";
import type { GetColumnData, SQL } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** The nullable columns one state requires to be set or to be empty. */
type StateFields = {
  readonly required?: readonly AnyPgColumn[];
  readonly absent?: readonly AnyPgColumn[];
};

type StateFieldsCheckOptions<TColumn extends AnyPgColumn> = {
  name: string;
  state: TColumn;
  // Total over the column's domain: a new state is a compile error until it
  // declares what it carries.
  rules: Readonly<Record<GetColumnData<TColumn> & string, StateFields>>;
};

const stateLiteral = (value: string) =>
  sql.raw(`'${value.replaceAll("'", "''")}'`);

/**
 * One CHECK binding every state to the columns it carries, so a row whose
 * fields belong to another state cannot be written by any writer.
 */
export const stateFieldsCheck = <TColumn extends AnyPgColumn>({
  name,
  state,
  rules,
}: StateFieldsCheckOptions<TColumn>) => {
  const branches = Object.entries<StateFields>(rules).map(
    ([value, { required = [], absent = [] }]) =>
      sql.join(
        [
          sql`${state} = ${stateLiteral(value)}`,
          ...required.map((column) => sql`${column} IS NOT NULL`),
          ...absent.map((column) => sql`${column} IS NULL`),
        ],
        sql` AND `,
      ),
  );
  // A value outside the domain is the domain check's refusal, not this one's.
  const outsideDomain = sql`${state} NOT IN (${sql.join(
    Object.keys(rules).map(stateLiteral),
    sql`, `,
  )})`;
  const condition: SQL = sql.join(
    [...branches, outsideDomain].map((branch) => sql`(${branch})`),
    sql` OR `,
  );
  return p.check(name, condition);
};
