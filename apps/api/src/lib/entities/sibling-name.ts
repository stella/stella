import { panic } from "better-result";
import * as v from "valibot";

import {
  ENTITY_NAME_MAX_LENGTH,
  truncateEntityName,
  type EntityKind,
} from "@stll/api-contract";

const resolvedSiblingNameSchema = v.pipe(
  v.string(),
  v.brand("ResolvedSiblingName"),
);

export type ResolvedSiblingName = v.InferOutput<
  typeof resolvedSiblingNameSchema
>;

type ResolveSiblingNameOptions = {
  name: string;
  kind: EntityKind;
  siblingNames: ReadonlySet<string>;
};

export const resolveSiblingName = ({
  name,
  kind,
  siblingNames,
}: ResolveSiblingNameOptions): ResolvedSiblingName => {
  if (!siblingNames.has(name)) {
    return v.parse(resolvedSiblingNameSchema, name);
  }
  const lastDot = kind === "document" ? name.lastIndexOf(".") : -1;
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const extension = lastDot > 0 ? name.slice(lastDot) : "";
  for (let number = 1; number <= siblingNames.size + 1; number += 1) {
    const suffix = `_${number}`;
    const boundedExtension = truncateEntityName(
      extension,
      ENTITY_NAME_MAX_LENGTH - suffix.length,
    );
    const boundedBase = truncateEntityName(
      base,
      ENTITY_NAME_MAX_LENGTH - suffix.length - boundedExtension.length,
    );
    const candidate = `${boundedBase}${suffix}${boundedExtension}`;
    if (!siblingNames.has(candidate)) {
      return v.parse(resolvedSiblingNameSchema, candidate);
    }
  }
  return panic("Finite siblings exhausted every distinct name candidate");
};
