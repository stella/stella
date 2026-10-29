import { MONEY_SCHEMA_BRAND } from "@stll/api-contract/billing-money";

import { isRecord } from "@/api/lib/type-guards";

type MoneyPath = { path: readonly string[]; nullable: boolean };

/** Inspect schema actions rather than field names, including nested and renamed money. */
type WalkMoneyOptions = {
  schema: unknown;
  path: readonly string[];
  nullable: boolean;
};
const walkMoney = ({
  schema,
  path,
  nullable,
}: WalkMoneyOptions): MoneyPath[] => {
  if (!isRecord(schema)) {
    return [];
  }
  const pipe = schema["pipe"];
  if (
    Array.isArray(pipe) &&
    pipe.some(
      (action) =>
        isRecord(action) &&
        action["type"] === "brand" &&
        action["name"] === MONEY_SCHEMA_BRAND,
    )
  ) {
    return [{ path, nullable }];
  }
  const entries = schema["entries"];
  if (isRecord(entries)) {
    return Object.entries(entries).flatMap(([key, child]) =>
      walkMoney({ schema: child, path: [...path, key], nullable: false }),
    );
  }
  const wrapped = schema["wrapped"];
  if (wrapped !== undefined) {
    return walkMoney({
      schema: wrapped,
      path,
      nullable:
        nullable ||
        schema["type"] === "nullable" ||
        schema["type"] === "nullish",
    });
  }
  const item = schema["item"];
  if (item !== undefined) {
    return walkMoney({ schema: item, path: [...path, "[]"], nullable: false });
  }
  if (schema["type"] === "record") {
    return walkMoney({
      schema: schema["value"],
      path: [...path, "*"],
      nullable: false,
    });
  }
  const items = schema["items"];
  if (Array.isArray(items)) {
    return items.flatMap((child, index) =>
      walkMoney({
        schema: child,
        path: [...path, index.toString()],
        nullable: false,
      }),
    );
  }
  const options = schema["options"];
  if (Array.isArray(options)) {
    return options.flatMap((option) =>
      walkMoney({ schema: option, path, nullable }),
    );
  }
  if (Array.isArray(pipe)) {
    return walkMoney({ schema: pipe.at(0), path, nullable });
  }
  return [];
};

export const moneyPaths = (schema: unknown): MoneyPath[] =>
  walkMoney({ schema, path: [], nullable: false });

const hasValueAtPath = (value: unknown, path: readonly string[]): boolean => {
  if (value === null || value === undefined) {
    return false;
  }
  const segment = path.at(0);
  if (segment === undefined) {
    return true;
  }
  if (segment === "[]") {
    return (
      Array.isArray(value) &&
      value.some((item) => hasValueAtPath(item, path.slice(1)))
    );
  }
  if (segment === "*") {
    return (
      isRecord(value) &&
      Object.values(value).some((item) => hasValueAtPath(item, path.slice(1)))
    );
  }
  if (Array.isArray(value)) {
    return hasValueAtPath(value.at(Number(segment)), path.slice(1));
  }
  return isRecord(value) && hasValueAtPath(value[segment], path.slice(1));
};

/** Common handler egress refuses non-null Money without monetary authority. */
export const hasVisibleMoney = (schema: unknown, value: unknown): boolean =>
  moneyPaths(schema).some(({ path }) => hasValueAtPath(value, path));
