#!/usr/bin/env bun
// Build-time codegen (spec 051 S5.2, build-time call site). Reads the committed
// registry snapshot (produced by `apps/api/scripts/export-mcp-tool-registry.ts`,
// the only place the heavy registry imports resolve), runs the pure
// `generateRouteMap` with the baked-in Annotation Table, and writes the result
// to `generated/route-map.ts`. The snapshot keeps `@stll/cli` free of any
// `apps/api` import; the committed output means registry drift shows as a diff.
//
// Run via `bun run codegen` (which regenerates the snapshot first).

import { panic } from "better-result";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";

import packageJson from "../package.json" with { type: "json" };
import {
  type CapabilityCatalogEntry,
  insertCapabilities,
} from "./generate-capability-tree.js";
import { generateResourceTree } from "./generate-resource-tree.js";
import { generateRouteMap } from "./generate-route-map.js";
import { generateCliSkill, SKILL_NAME } from "./generate-skill.js";
import type { ResourceListing } from "./resource-types.js";
import type {
  DiscriminatorSubcommand,
  RegistryToolListing,
  ToolAnnotation,
} from "./route-types.js";

const snapshotUrl = new URL(
  "generated/registry-snapshot.json",
  import.meta.url,
);
const catalogUrl = new URL(
  "generated/capability-catalog.json",
  import.meta.url,
);
const outputUrl = new URL("generated/route-map.ts", import.meta.url);
const resourceSnapshotUrl = new URL(
  "generated/resources-snapshot.json",
  import.meta.url,
);
const resourceOutputUrl = new URL(
  "generated/resource-tree.ts",
  import.meta.url,
);
const annotationOutputUrl = new URL(
  "generated/tool-annotations.ts",
  import.meta.url,
);

const toolScopes = [
  "read",
  "matters_write",
  "documents_write",
  "knowledge_write",
  "search",
  "onboarding",
  "templates",
  "billing_write",
  "admin_read",
  "admin_write",
  "feedback",
] as const;

const stringArraySchema = v.array(v.string());

const discriminatorSubcommandSchema = v.looseObject({
  command: v.string(),
  destructive: v.optional(v.literal(true)),
  include: v.optional(stringArraySchema),
  required: v.optional(stringArraySchema),
});

const cliAnnotationSchema = v.looseObject({
  command: stringArraySchema,
  excluded: v.optional(v.literal(true)),
  scope: v.optional(v.picklist(toolScopes)),
  itemsKey: v.optional(v.string()),
  singleReadWhen: v.optional(v.string()),
  columns: v.optional(stringArraySchema),
  windowedText: v.optional(v.literal(true)),
  paginationless: v.optional(v.literal(true)),
  inputOnly: v.optional(stringArraySchema),
  discriminator: v.optional(
    v.looseObject({
      prop: v.string(),
      subcommands: v.record(v.string(), discriminatorSubcommandSchema),
    }),
  ),
  flagRename: v.optional(v.record(v.string(), v.string())),
  confirmPassthrough: v.optional(v.literal(true)),
});

type ParsedDiscriminatorSubcommand = v.InferOutput<
  typeof discriminatorSubcommandSchema
>;
type ParsedCliAnnotation = v.InferOutput<typeof cliAnnotationSchema>;

const projectDiscriminatorSubcommand = (
  subcommand: ParsedDiscriminatorSubcommand,
): DiscriminatorSubcommand => {
  const projected: DiscriminatorSubcommand = { command: subcommand.command };
  if (subcommand.destructive !== undefined) {
    projected.destructive = subcommand.destructive;
  }
  if (subcommand.include !== undefined) {
    projected.include = subcommand.include;
  }
  if (subcommand.required !== undefined) {
    projected.required = subcommand.required;
  }
  return projected;
};

const projectToolAnnotation = (cli: ParsedCliAnnotation): ToolAnnotation => {
  const annotation: ToolAnnotation = { command: cli.command };
  if (cli.excluded !== undefined) {
    annotation.excluded = cli.excluded;
  }
  if (cli.scope !== undefined) {
    annotation.scope = cli.scope;
  }
  if (cli.itemsKey !== undefined) {
    annotation.itemsKey = cli.itemsKey;
  }
  if (cli.singleReadWhen !== undefined) {
    annotation.singleReadWhen = cli.singleReadWhen;
  }
  if (cli.columns !== undefined) {
    annotation.columns = cli.columns;
  }
  if (cli.windowedText !== undefined) {
    annotation.windowedText = cli.windowedText;
  }
  if (cli.paginationless !== undefined) {
    annotation.paginationless = cli.paginationless;
  }
  if (cli.inputOnly !== undefined) {
    annotation.inputOnly = cli.inputOnly;
  }
  if (cli.discriminator !== undefined) {
    const subcommands: Record<string, DiscriminatorSubcommand> = {};
    for (const [key, subcommand] of Object.entries(
      cli.discriminator.subcommands,
    )) {
      subcommands[key] = projectDiscriminatorSubcommand(subcommand);
    }
    annotation.discriminator = {
      prop: cli.discriminator.prop,
      subcommands,
    };
  }
  if (cli.flagRename !== undefined) {
    annotation.flagRename = cli.flagRename;
  }
  if (cli.confirmPassthrough !== undefined) {
    annotation.confirmPassthrough = cli.confirmPassthrough;
  }
  return annotation;
};

// Validate the snapshot into the four wire fields so the codegen input is typed
// (not `any` off `.json()`) and a malformed snapshot fails loudly.
const listingSchema = v.array(
  v.looseObject({
    cli: cliAnnotationSchema,
    name: v.string(),
    description: v.string(),
    inputSchema: v.record(v.string(), v.unknown()),
    annotations: v.optional(
      v.looseObject({
        readOnlyHint: v.optional(v.boolean()),
        destructiveHint: v.optional(v.boolean()),
      }),
    ),
  }),
);

const snapshot = v.safeParse(
  listingSchema,
  JSON.parse(await readFile(snapshotUrl, "utf-8")),
);
if (!snapshot.success) {
  panic("registry-snapshot.json does not match the expected listing shape");
}

// Project the validated snapshot to the exact `RegistryToolListing` shape
// (dropping valibot's `| undefined` widening on optional annotation hints).
const listings: RegistryToolListing[] = [];
const toolAnnotations: Record<string, ToolAnnotation> = {};
for (const tool of snapshot.output) {
  const annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {};
  if (tool.annotations?.readOnlyHint !== undefined) {
    annotations.readOnlyHint = tool.annotations.readOnlyHint;
  }
  if (tool.annotations?.destructiveHint !== undefined) {
    annotations.destructiveHint = tool.annotations.destructiveHint;
  }
  listings.push({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations === undefined ? {} : { annotations }),
  });
  toolAnnotations[tool.name] = projectToolAnnotation(tool.cli);
}

const curatedRouteMap = generateRouteMap(listings, toolAnnotations);

// Project the committed capability-catalog snapshot into leaf commands and merge
// them into the SAME curated tree (spec 049 Phase 3). The catalog is trusted,
// committed data (owned by the api-side exporter), validated here only to the
// fields the CLI codegen consumes so a malformed snapshot fails loudly.
const jsonSchemaSchema = v.record(v.string(), v.unknown());
const catalogEntrySchema = v.looseObject({
  id: v.string(),
  handlerKind: v.picklist(["workspace", "root", "session"]),
  access: v.picklist(["read", "write"]),
  destructive: v.boolean(),
  scope: v.string(),
  requiresFileInput: v.optional(v.boolean()),
  returnsFileResponse: v.optional(v.boolean()),
  inputSchemaTruncated: v.optional(v.boolean()),
  inputSchema: v.optional(
    v.looseObject({
      body: v.optional(jsonSchemaSchema),
      params: v.optional(jsonSchemaSchema),
      query: v.optional(jsonSchemaSchema),
    }),
  ),
});
const catalogParse = v.safeParse(
  v.array(catalogEntrySchema),
  JSON.parse(await readFile(catalogUrl, "utf-8")),
);
if (!catalogParse.success) {
  panic("capability-catalog.json does not match the expected entry shape");
}
// Project valibot output (with `| undefined` widening on optionals) to the
// generator's entry shape, dropping absent optionals so `exactOptionalPropertyTypes`
// stays satisfied.
const catalogEntries: CapabilityCatalogEntry[] = catalogParse.output.map(
  (entry) => {
    const projected: CapabilityCatalogEntry = {
      id: entry.id,
      handlerKind: entry.handlerKind,
      access: entry.access,
      destructive: entry.destructive,
      scope: entry.scope,
    };
    if (entry.requiresFileInput !== undefined) {
      projected.requiresFileInput = entry.requiresFileInput;
    }
    if (entry.returnsFileResponse !== undefined) {
      projected.returnsFileResponse = entry.returnsFileResponse;
    }
    if (entry.inputSchemaTruncated !== undefined) {
      projected.inputSchemaTruncated = entry.inputSchemaTruncated;
    }
    if (entry.inputSchema !== undefined) {
      const parts: NonNullable<CapabilityCatalogEntry["inputSchema"]> = {};
      if (entry.inputSchema.body !== undefined) {
        parts.body = entry.inputSchema.body;
      }
      if (entry.inputSchema.params !== undefined) {
        parts.params = entry.inputSchema.params;
      }
      if (entry.inputSchema.query !== undefined) {
        parts.query = entry.inputSchema.query;
      }
      projected.inputSchema = parts;
    }
    return projected;
  },
);

const { tree: routeMap, stats: capabilityStats } = insertCapabilities({
  tree: curatedRouteMap,
  entries: catalogEntries,
});
process.stderr.write(
  `Capability tree: ${capabilityStats.generated} leaves generated, ${capabilityStats.suppressed} suppressed (file input/output), ${capabilityStats.collisionFallbacks.length} collision fallback(s), ${capabilityStats.flagCollisions.length} flag collision(s)\n`,
);
if (capabilityStats.collisionFallbacks.length > 0) {
  process.stderr.write(
    `  collision fallbacks -> capability <domain> <action>: ${capabilityStats.collisionFallbacks.join(", ")}\n`,
  );
}
if (capabilityStats.flagCollisions.length > 0) {
  process.stderr.write(
    `  flag collisions (part-prefixed): ${capabilityStats.flagCollisions
      .map(({ id, flag }) => `${id}:${flag}`)
      .join(", ")}\n`,
  );
}

// Emit the TanStack Intent agent skill from the same registry inputs, into the
// spec-mandated `skills/<name>/SKILL.md` at the package root. Committing it means
// registry drift shows up as a diff here too (guarded by scripts/verify.sh and
// the CLI registry snapshot CI step, which git-diff `packages/cli/skills`).
const skillUrl = new URL(`../skills/${SKILL_NAME}/SKILL.md`, import.meta.url);
await mkdir(new URL(`../skills/${SKILL_NAME}/`, import.meta.url), {
  recursive: true,
});
await writeFile(
  skillUrl,
  generateCliSkill(listings, toolAnnotations, {
    commandCount: capabilityStats.generated,
  }),
);
process.stderr.write(`Wrote ${skillUrl.pathname}\n`);

const annotationHeader = `// GENERATED by \`bun run codegen\`. Do not edit by hand.
//
// API-owned CLI metadata projected from \`registry-snapshot.json\`. This keeps
// the runtime registry-refresh path on the same command-shaping metadata as the
// build-time route map without maintaining a second handwritten table.

import type { ToolAnnotation } from "../route-types.js";

export const generatedToolAnnotations: Readonly<Record<string, ToolAnnotation>> = `;

await writeFile(
  annotationOutputUrl,
  `${annotationHeader}${JSON.stringify(toolAnnotations, null, 2)};\n`,
);

process.stderr.write(`Wrote ${annotationOutputUrl.pathname}\n`);

const header = `/* eslint-disable unicorn/numeric-separators-style -- generated JSON literals */
// GENERATED by \`bun run codegen\` (spec 051 S5.2). Do not edit by hand.
//
// The committed route tree built from the MCP tool registry snapshot through
// \`generateRouteMap\`. Regenerate after any registry change; drift shows up here
// as a diff instead of a runtime surprise.

import type { RouteNode } from "../route-types.js";

export const generatedRouteMap: RouteNode = `;

await writeFile(outputUrl, `${header}${JSON.stringify(routeMap, null, 2)};\n`);

process.stderr.write(`Wrote ${outputUrl.pathname}\n`);

// The resource tree (spec 051 S5.4) is generated the same way from its own
// snapshot so `reference list`/`reference show` can never drift from the
// server's static resources.
const resourceSchema = v.array(
  v.strictObject({
    uri: v.string(),
    name: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    mimeType: v.optional(v.string()),
  }),
);

const resourceSnapshot = v.safeParse(
  resourceSchema,
  JSON.parse(await readFile(resourceSnapshotUrl, "utf-8")),
);
if (!resourceSnapshot.success) {
  panic("resources-snapshot.json does not match the expected listing shape");
}

// Project to the exact `ResourceListing` shape, dropping valibot's `| undefined`
// widening on the optional fields under `exactOptionalPropertyTypes`.
const resourceListings: ResourceListing[] = [];
for (const resource of resourceSnapshot.output) {
  const listing: ResourceListing = { uri: resource.uri, name: resource.name };
  if (resource.title !== undefined) {
    listing.title = resource.title;
  }
  if (resource.description !== undefined) {
    listing.description = resource.description;
  }
  if (resource.mimeType !== undefined) {
    listing.mimeType = resource.mimeType;
  }
  resourceListings.push(listing);
}

const resourceTree = generateResourceTree(resourceListings);

const resourceHeader = `// GENERATED by \`bun run codegen\` (spec 051 S5.4). Do not edit by hand.
//
// The committed resource tree built from the MCP \`resources/list\` snapshot
// through \`generateResourceTree\`. Regenerate after any resource change; drift
// shows up here as a diff instead of a runtime surprise.

import type { ResourceNode } from "../resource-types.js";

export const generatedResourceTree: ResourceNode = `;

await writeFile(
  resourceOutputUrl,
  `${resourceHeader}${JSON.stringify(resourceTree, null, 2)};\n`,
);

process.stderr.write(`Wrote ${resourceOutputUrl.pathname}\n`);

// Bake the package version in at codegen time (spec 051 addendum: the CLI update
// nudge must not read package.json at runtime from dist). Regenerating after a
// version bump keeps this in lockstep with package.json.
const versionOutputUrl = new URL("generated/cli-version.ts", import.meta.url);
const versionHeader = `// GENERATED by \`bun run codegen\`. Do not edit by hand.
//
// The running CLI's own version, baked in at codegen time so the update nudge
// (spec 051 addendum) never reads package.json from the published dist.

export const CLI_VERSION = `;
await writeFile(
  versionOutputUrl,
  `${versionHeader}${JSON.stringify(packageJson.version)};\n`,
);

process.stderr.write(`Wrote ${versionOutputUrl.pathname}\n`);
