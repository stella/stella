// The one owner of Bun SQL clients and the drizzle databases on top of them.
//
// Bun 1.4.4 decodes every Postgres int8 as a string unless the client is
// constructed with `bigint: true`; drizzle sets that option after
// construction, which no longer takes effect. A string int8 compares
// lexically ("10" < "9"), so every client is built here with `bigint: true`,
// and int8 columns decode to their declared mode: a BigInt, or a Number
// proven to be a safe integer. Lint (`sql-client-owner`) refuses `new SQL`
// and drizzle's bun-sql factory anywhere else.

import { panic } from "better-result";
import { SQL } from "bun";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import { bunSqlPgCodecs, drizzle } from "drizzle-orm/bun-sql/postgres";
import type { DrizzlePgConfig } from "drizzle-orm/pg-core";

/** Options of a Postgres client; `bigint` is always on and cannot be turned off. */
export type SqlClientOptions = Omit<SQL.PostgresOrMySQLOptions, "bigint">;

/** A Bun SQL client whose int8 values decode as BigInt. */
export const createSqlClient = (options: SqlClientOptions): SQL =>
  new SQL({ ...options, bigint: true });

/** An int8 value in `mode: "number"`: a Number only when it is a safe integer. */
export const int8ToSafeNumber = (value: unknown): number => {
  const decoded =
    typeof value === "bigint" || typeof value === "string"
      ? Number(value)
      : value;
  if (typeof decoded !== "number" || !Number.isSafeInteger(decoded)) {
    return panic(
      `int8 value ${String(value)} is not a safe integer; declare the column in mode "bigint"`,
    );
  }
  return decoded;
};

/** An int8 value in `mode: "bigint"`. */
export const int8ToBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value)) {
    return BigInt(value);
  }
  return panic(`int8 value ${String(value)} is not an integer`);
};

/** drizzle's bun-sql codecs with int8 decoded to each column's declared mode. */
export const stellaPgCodecs: typeof bunSqlPgCodecs = {
  ...bunSqlPgCodecs,
  bigint: { ...bunSqlPgCodecs.bigint, normalize: int8ToBigInt },
  bigserial: { ...bunSqlPgCodecs.bigserial, normalize: int8ToBigInt },
  "bigint:number": {
    ...bunSqlPgCodecs["bigint:number"],
    normalize: int8ToSafeNumber,
  },
  "bigserial:number": {
    ...bunSqlPgCodecs["bigserial:number"],
    normalize: int8ToSafeNumber,
  },
};

/** A drizzle database over a client from {@link createSqlClient}, decoding int8 by column mode. */
export const createDatabase = <
  TRelations extends AnyRelations = EmptyRelations,
  TClient extends SQL = SQL,
>(
  config: Omit<DrizzlePgConfig<TRelations>, "codecs"> & { client: TClient },
) => drizzle<TRelations, TClient>({ ...config, codecs: stellaPgCodecs });

/** A client-less drizzle database for building and inspecting queries, with the same codecs. */
export const createMockDatabase = <
  TRelations extends AnyRelations = EmptyRelations,
>(
  config: Omit<DrizzlePgConfig<TRelations>, "codecs"> = {},
) => drizzle.mock<TRelations>({ ...config, codecs: stellaPgCodecs });
