// Capability description guard.
//
// A capability's `description` is executable interface documentation, not a
// comment: the exporter carries it from the handler config into the committed
// catalog, and from there it becomes the generated CLI command's
// `--help` brief and the prose an MCP client reads before deciding whether to
// call the tool. A capability without one is briefed to an agent as "Invoke the
// <id> capability", which is no basis for that decision.
//
// Every capability in the committed catalog therefore carries one: a missing,
// empty or whitespace-only description fails. `description` is still optional
// on the handler config's type, so this guard is what requires it.
//
// Reads the committed catalog rather than importing the handler graph: no env,
// no module loading, and the artifact is already pinned to the live
// handlers by the capability-catalog drift guard
// (`export-capability-catalog.ts --check`), which runs beside this one. A stale
// artifact therefore cannot hide debt from this guard without failing that one.
//
// Modes:
//   bun apps/api/scripts/capability-description-guard.ts              CI gate (exit 1 on failure)
//   bun apps/api/scripts/capability-description-guard.ts --self-test  prove the detector fires
//
// Wired into `.github/workflows/ci.yml` and `bun run verify` next to the
// capability-catalog drift guard.

import { panic } from "better-result";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readCapabilityCatalog } from "../../../packages/cli/src/capability-catalog-data";
import { parseCapabilityCatalog } from "../../../packages/cli/src/capability-catalog-load";
import { REPO_ROOT } from "./lib/enumerate-safe-handlers";

const CATALOG_PATH = "packages/cli/capabilities/";

type CatalogEntry = { id: string; description?: string };

/**
 * Ids of capabilities carrying no usable description, sorted. Blank and
 * whitespace-only prose counts as missing so an empty string cannot stand in
 * for writing anything.
 */
export const findUndescribedIds = (
  entries: readonly CatalogEntry[],
): string[] =>
  entries
    .filter(
      ({ description }) =>
        description === undefined || description.trim().length === 0,
    )
    .map(({ id }) => id)
    .toSorted();

const readCatalog = (relativePath: string): CatalogEntry[] => {
  const absolute = path.resolve(REPO_ROOT, relativePath);
  const raw = readCapabilityCatalog(pathToFileURL(`${absolute}/`));
  const parsed = parseCapabilityCatalog(raw);
  if (parsed === null) {
    return panic(
      `capability-description-guard: ${relativePath} is not a valid capability catalog.`,
    );
  }
  return parsed.map(({ id, description }) =>
    description === undefined ? { id } : { id, description },
  );
};

type Loaded = {
  catalogIds: string[];
  undescribed: string[];
};

const loadCatalog = (): Loaded => {
  const entries = readCatalog(CATALOG_PATH);
  return {
    catalogIds: entries.map(({ id }) => id).toSorted(),
    undescribed: findUndescribedIds(entries),
  };
};

const runCheck = (): number => {
  const { catalogIds, undescribed } = loadCatalog();

  if (catalogIds.length === 0) {
    console.error(
      "\ncapability-description-guard: the catalog is empty — the guard did not exercise anything. Fix the committed catalog before trusting a green run.",
    );
    return 1;
  }

  if (undescribed.length > 0) {
    console.error(
      "\ncapability-description-guard: these capabilities have no `description`. Write the prose on the handler config (see CapabilityDescription in apps/api/src/lib/api-handlers.ts):",
    );
    for (const id of undescribed) {
      console.error(`  ${id}`);
    }
    return 1;
  }

  console.log(
    `capability-description-guard: OK. ${catalogIds.length} capabilities, all described.`,
  );
  return 0;
};

// Self-test: prove the detector fires on synthetic input, through the same
// pure function the real check uses. A broken detector cannot pass here.
const runSelfTest = (): number => {
  const failures: string[] = [];

  const undescribed = findUndescribedIds([
    { id: "a.get", description: "Reads an a." },
    { id: "b.get" },
    { id: "c.get", description: "   " },
    { id: "d.get", description: "" },
  ]);
  if (undescribed.join(",") !== "b.get,c.get,d.get") {
    failures.push(
      `findUndescribedIds did not treat absent/blank prose as missing (got ${undescribed.join(",")})`,
    );
  }

  if (failures.length > 0) {
    console.error("capability-description-guard --self-test: FAIL");
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    return 1;
  }
  console.log("capability-description-guard --self-test: PASS");
  return 0;
};

if (import.meta.main) {
  process.exit(
    process.argv.includes("--self-test") ? runSelfTest() : runCheck(),
  );
}
