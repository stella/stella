import { panic } from "better-result";

import type { PresentationApp } from "../manifest";
import projections from "./generated/input-projections.json";

type AppToolName = PresentationApp["callableTools"][number];

projections satisfies Record<AppToolName, unknown>;

export const projectAppToolArguments = (
  name: AppToolName,
  input: Record<string, unknown>,
) =>
  Object.fromEntries(
    projections[name].properties.flatMap((key) =>
      Object.hasOwn(input, key) ? [[key, input[key]]] : [],
    ),
  );

export const getAppToolArrayLimit = (name: AppToolName, property: string) => {
  const limit = Object.entries(projections[name].arrayLimits).find(
    ([key]) => key === property,
  )?.[1];
  if (limit === undefined) {
    return panic("App array field must declare maxItems", property);
  }
  return limit;
};
