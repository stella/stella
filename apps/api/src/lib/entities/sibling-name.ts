import { panic } from "better-result";
import * as v from "valibot";

import {
  ENTITY_NAME_MAX_LENGTH,
  type EntityKind,
  truncateEntityName,
} from "@stll/api-contract";

import { normalizeEntityName } from "@/api/lib/entities/entity-name";

const resolvedSiblingNameSchema = v.pipe(
  v.string(),
  v.brand("EntityName"),
  v.brand("ResolvedSiblingName"),
);

export type ResolvedSiblingName = v.InferOutput<
  typeof resolvedSiblingNameSchema
>;

/** How a taken name is numbered: `Name_1`, `Name_2`, as uploads are, or
 *  `Name (2)`, `Name (3)`, as a file manager numbers a copy. */
const SIBLING_NUMBERING = ["underscore", "parenthesized"] as const;
export type SiblingNumbering = (typeof SIBLING_NUMBERING)[number];

const numberSuffix = (numbering: SiblingNumbering, number: number): string => {
  switch (numbering) {
    case "underscore":
      return `_${number}`;
    case "parenthesized":
      // The unnumbered name is the first, so the next one is the second.
      return ` (${number + 1})`;
    default:
      numbering satisfies never;
      return panic("Unknown sibling numbering");
  }
};

type ResolveSiblingNameOptions = {
  name: string;
  kind: EntityKind;
  siblingNames: ReadonlySet<string>;
  numbering?: SiblingNumbering;
};

export const resolveSiblingName = ({
  name: requestedName,
  kind,
  siblingNames,
  numbering = "underscore",
}: ResolveSiblingNameOptions): ResolvedSiblingName => {
  const name = normalizeEntityName(requestedName);
  if (!siblingNames.has(name)) {
    return v.parse(resolvedSiblingNameSchema, name);
  }
  const lastDot = kind === "document" ? name.lastIndexOf(".") : -1;
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const extension = lastDot > 0 ? name.slice(lastDot) : "";
  for (let number = 1; number <= siblingNames.size + 1; number += 1) {
    const suffix = numberSuffix(numbering, number);
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
