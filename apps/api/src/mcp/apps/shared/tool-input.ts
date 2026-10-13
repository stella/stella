import { panic } from "better-result";

import {
  normalizeAgentInput,
  withNullOptionalsOmitted,
} from "@stll/agent-input";
import { MCP_AGENT_INPUT_READERS } from "@stll/legal-atlas/agent-input-readers";

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
  const normalized = normalizeAgentInput({
    schema: schemas[name],
    readers: MCP_AGENT_INPUT_READERS,
    value: withNullOptionalsOmitted(schemas[name], input),
    placeholders: "absent",
  });
  if (!normalized.ok) {
    return {
      status: "invalid",
      fields: normalized.issues.map(({ path }) => path),
    } as const;
  }
  if (
    typeof normalized.value !== "object" ||
    normalized.value === null ||
    Array.isArray(normalized.value)
  ) {
    return panic("App object input normalized to a non-object value", name);
  }
  const arguments_ = Object.fromEntries(Object.entries(normalized.value));
  const validate = validators[name];
  if (validate(arguments_)) {
    return { status: "valid", arguments: arguments_ } as const;
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
    field === null ||
    !("maxItems" in field) ||
    typeof field.maxItems !== "number"
  ) {
    return panic("App array field must declare maxItems", property);
  }
  return field.maxItems;
};
