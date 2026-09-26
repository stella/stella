import { panic } from "better-result";

import { isEffectivelyInstalled, type CatalogueEntry } from "./catalogue-types";

/**
 * How the catalogue's Remove action treats an entry: not offered, done at once
 * (turning a built-in tool off is reversible from the same row), or only after
 * confirmation, because removing a skill or an integration deletes it and its
 * configuration.
 */
export type CatalogueRemoval = "none" | "immediate" | "confirm";

export const catalogueRemoval = (entry: CatalogueEntry): CatalogueRemoval => {
  if (!isEffectivelyInstalled(entry) || entry.isLocked) {
    return "none";
  }
  switch (entry.kind) {
    case "native-tool":
      return "immediate";
    case "mcp":
      return entry.installedConnectorSlug === null ? "none" : "confirm";
    case "skill":
      return entry.installedSkillId === null ? "none" : "confirm";
    default: {
      entry satisfies never;
      return panic(`Unhandled catalogue entry: ${String(entry)}`);
    }
  }
};
