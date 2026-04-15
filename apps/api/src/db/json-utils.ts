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

export const jsonField =
  <TVersion extends ContentVersion, TColumn extends Columns = Columns>(
    column: TColumn,
    _version: `v${TVersion}`,
  ) =>
  <TKey extends ColumnDataKeys<TColumn, TVersion>>(key: TKey) => {
    if (typeof key !== "string") {
      panic("JSON field key literal must be a string");
    }

    if (column.dataType !== "object json") {
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

  return sql.raw(`'${value}'`);
};

export const jsonValueLiteral = <
  TData extends ColumnContent,
  TVersion extends ContentVersion,
>(
  value: VersionedValues<TData, TVersion>,
) => {
  if (typeof value === "string" || typeof value === "number") {
    return sql.raw(`'${value}'`);
  }

  return panic("JSON field value literal must be a string or number");
};
