import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { fields, properties } from "@/api/db/schema";
import type { FieldContent, PropertyContent } from "@/api/db/schema-validators";

type Columns = typeof properties.content | typeof fields.content;
type ColumnContent = PropertyContent | FieldContent;
type ContentVersion = ColumnContent["version"];

type KeysOfUnion<TData, TVersion extends ContentVersion> = TData extends {
  version: TVersion;
}
  ? keyof TData
  : never;

type ColumnData<TColumn extends Columns> = TColumn["_"]["data"];

type ValueOfKey<TData, TKey> =
  TData extends Record<TKey & string, infer V> ? V : never;

type ColumnDataKeys<
  TColumn extends Columns,
  TVersion extends ContentVersion,
> = KeysOfUnion<ColumnData<TColumn>, TVersion>;

type VersionedValues<
  TData extends ColumnContent,
  TVersion extends ContentVersion,
> = TData extends {
  version: TVersion;
}
  ? TData["type"] | TData["version"]
  : never;

// jsonField/jsonLiteral/jsonValueLiteral splice their argument straight into a raw
// SQL fragment via `sql.raw`, not a bound parameter: the fragments they build are
// meant to be reused verbatim in multiple positions of one query (e.g. a SELECT
// column reused in its own GROUP BY), and Drizzle assigns a fresh placeholder number
// to each occurrence of a bound value, which makes Postgres see the two positions as
// different expressions. Their TypeScript signatures narrow the argument to a union
// of the schema's literal keys/values, but that narrowing is compile-time only:
// nothing stops a differently-typed caller (or an `as` cast) from handing in
// arbitrary runtime data. Enforce the "identifier-like compile-time constant"
// contract at runtime too, so a future caller that threads request-derived data
// through these helpers fails loudly instead of splicing it into SQL text.
const RAW_SQL_LITERAL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export const assertIdentifierLiteral = (value: string): void => {
  if (!RAW_SQL_LITERAL_PATTERN.test(value)) {
    panic(
      `Raw SQL literal must be an identifier-like value (letters, digits, "_", "-"); received ${JSON.stringify(value)}`,
    );
  }
};

export const jsonField =
  <TVersion extends ContentVersion, TColumn extends Columns = Columns>(
    column: TColumn,
    _version: `v${TVersion}`,
  ) =>
  <TKey extends ColumnDataKeys<TColumn, TVersion>>(key: TKey) => {
    if (typeof key !== "string") {
      panic("JSON field key literal must be a string");
    }
    assertIdentifierLiteral(key);

    if (column.getSQLType() !== "jsonb") {
      panic("Column must be a JSON column");
    }

    return sql<
      ValueOfKey<ColumnData<TColumn>, TKey>
    >`${column}->>'${sql.raw(key)}'`;
  };

export const jsonLiteral = <
  TData extends ColumnContent,
  TVersion extends ContentVersion,
>(
  value: KeysOfUnion<TData, TVersion>,
) => {
  if (typeof value !== "string") {
    panic("JSON field value literal must be a string");
  }
  assertIdentifierLiteral(value);

  return sql.raw(`'${value}'`);
};

export const jsonValueLiteral = <
  TData extends ColumnContent,
  TVersion extends ContentVersion,
>(
  value: VersionedValues<TData, TVersion>,
) => {
  if (typeof value === "string" || typeof value === "number") {
    const literal = String(value);
    assertIdentifierLiteral(literal);

    return sql.raw(`'${literal}'`);
  }

  return panic("JSON field value literal must be a string or number");
};
