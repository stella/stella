import { panic } from "better-result";

import type { PresentationApp } from "../manifest";
import schemas from "./generated/input-schemas.json";
import validators from "./generated/input-validators.js";

type AppToolName = PresentationApp["callableTools"][number];

validators satisfies Record<AppToolName, (input: unknown) => boolean>;
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

export const validateAppToolArguments = (
  name: AppToolName,
  input: Record<string, unknown>,
) => {
  const validate = validators[name];
  if (validate(input)) {
    return { status: "valid", arguments: input } as const;
  }
  const fields = [
    ...new Set(
      (validate.errors ?? []).map(({ instancePath, params }) => {
        const missing = params["missingProperty"];
        return (
          instancePath.replace(/^\//u, "").replaceAll("/", ".") ||
          (typeof missing === "string" ? missing : "arguments")
        );
      }),
    ),
  ];
  return { status: "invalid", fields } as const;
};
