import { panic } from "better-result";

import type { PresentationApp } from "../manifest";
import schemas from "./generated/input-schemas.json";

type AppToolName = PresentationApp["callableTools"][number];

schemas satisfies Record<AppToolName, unknown>;

export const projectAppToolArguments = (
  name: AppToolName,
  input: Record<string, unknown>,
) => {
  const schema = schemas[name];
  if (!("properties" in schema)) {
    return panic("App tool input must declare object properties", name);
  }
  return Object.fromEntries(
    Object.keys(schema.properties).flatMap((key) =>
      Object.hasOwn(input, key) ? [[key, input[key]]] : [],
    ),
  );
};

export const getAppToolArrayLimit = (name: AppToolName, property: string) => {
  const schema = schemas[name];
  if (!("properties" in schema)) {
    return panic("App tool input must declare object properties", name);
  }
  const field = Object.entries(schema.properties)
    .find(([key]) => key === property)
    ?.at(1);
  if (
    typeof field !== "object" ||
    !("maxItems" in field) ||
    typeof field.maxItems !== "number"
  ) {
    return panic("App array field must declare maxItems", property);
  }
  return field.maxItems;
};
