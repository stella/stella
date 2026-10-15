#!/usr/bin/env bun
// Build-time codegen (spec 051 S5.2, build-time call site). Reads the committed
// registry snapshot (produced by `apps/api/scripts/export-mcp-tool-registry.ts`,
// the only place the heavy registry imports resolve), runs the pure
// `generateRouteMap` with the baked-in Annotation Table, and writes the result
// to `generated/route-map.ts`. The snapshot keeps `@stll/cli` free of any
// `apps/api` import. Runtime modules are derived from committed inputs.
//
// Full codegen refreshes snapshots; --runtime-only derives just runtime modules.

import { panic, Result } from "better-result";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";

import {
  checkCapabilityRegistry,
  readCapabilityCatalog,
} from "./capability-catalog-data.js";
import { parseCapabilityCatalog } from "./capability-catalog-load.js";
import {
  buildCliRouteTree,
  capabilityDomainsOf,
} from "./generate-capability-tree.js";
import { MCP_CLI_TOOL_SCOPES } from "./generated/mcp-contract.js";
import type { ResourceListing } from "./resource-types.js";
import type {
  DiscriminatorSubcommand,
  RegistryToolListing,
  ToolAnnotation,
} from "./route-types.js";
import { MAX_REQUEST_TIMEOUT_MS } from "./route-types.js";
import { writeGeneratedFile } from "./write-generated-file.js";

const runtimeOnly = process.argv.includes("--runtime-only");

const snapshotUrl = new URL(
  "generated/registry-snapshot.json",
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

const stringArraySchema = v.array(v.string());

const discriminatorSubcommandSchema = v.object({
  command: v.string(),
  destructive: v.optional(v.boolean()),
  include: v.optional(stringArraySchema),
  required: v.optional(stringArraySchema),
});

const compositeSectionSchema = v.object({
  title: v.string(),
  rows: v.pipe(v.string(), v.minLength(1)),
  columns: stringArraySchema,
});

const cliAnnotationSchema = v.object({
  command: stringArraySchema,
  additionalScopes: v.optional(v.array(v.picklist(MCP_CLI_TOOL_SCOPES))),
  requestTimeoutMs: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(MAX_REQUEST_TIMEOUT_MS),
    ),
  ),
  excluded: v.optional(v.literal(true)),
  scope: v.optional(v.picklist(MCP_CLI_TOOL_SCOPES)),
  itemsKey: v.optional(v.string()),
  singleReadWhen: v.optional(v.string()),
  columns: v.optional(stringArraySchema),
  windowedText: v.optional(
    v.object({ textPath: v.pipe(v.string(), v.minLength(1)) }),
  ),
  paginationless: v.optional(v.literal(true)),
  perEntryCursor: v.optional(v.literal(true)),
  inputOnly: v.optional(stringArraySchema),
  discriminator: v.optional(
    v.object({
      prop: v.string(),
      subcommands: v.record(v.string(), discriminatorSubcommandSchema),
    }),
  ),
  flagRename: v.optional(v.record(v.string(), v.string())),
  feature: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  featureId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  localFileBase64Prop: v.optional(v.pipe(v.string(), v.minLength(1))),
  confirmPassthrough: v.optional(v.literal(true)),
  composite: v.optional(
    v.object({
      summary: stringArraySchema,
      sections: v.tupleWithRest(
        [compositeSectionSchema],
        compositeSectionSchema,
      ),
    }),
  ),
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
  if (cli.additionalScopes !== undefined) {
    annotation.additionalScopes = cli.additionalScopes;
  }
  if (cli.requestTimeoutMs !== undefined) {
    annotation.requestTimeoutMs = cli.requestTimeoutMs;
  }
  if (cli.excluded !== undefined) {
    annotation.excluded = cli.excluded;
  }
  if (cli.feature !== undefined) {
    annotation.feature = cli.feature;
  }
  if (cli.featureId !== undefined) {
    annotation.featureId = cli.featureId;
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
  if (cli.perEntryCursor !== undefined) {
    annotation.perEntryCursor = cli.perEntryCursor;
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
  if (cli.localFileBase64Prop !== undefined) {
    annotation.localFileBase64Prop = cli.localFileBase64Prop;
  }
  if (cli.confirmPassthrough !== undefined) {
    annotation.confirmPassthrough = cli.confirmPassthrough;
  }
  if (cli.composite !== undefined) {
    annotation.composite = cli.composite;
  }
  return annotation;
};

// Validate the snapshot into the four wire fields so the codegen input is typed
// (not `any` off `.json()`) and a malformed snapshot fails loudly.
const listingSchema = v.array(
  v.object({
    cli: cliAnnotationSchema,
    name: v.string(),
    description: v.string(),
    inputSchema: v.record(v.string(), v.unknown()),
    annotations: v.optional(
      v.object({
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

// Project the committed capability-catalog snapshot into leaf commands and
// merge them into the SAME curated tree (spec 049 Phase 3), through the ONE
// shared `buildCliRouteTree` the runtime registry-refresh path also uses. The
// catalog is trusted, committed data (owned by the api-side exporter),
// validated to the fields the CLI consumes so a malformed snapshot fails loudly.
const rawCatalog = readCapabilityCatalog();
checkCapabilityRegistry(rawCatalog, new Set(listings.map(({ name }) => name)));
const catalogEntries = parseCapabilityCatalog(rawCatalog);
if (catalogEntries === null) {
  panic("capability catalog shards do not match the expected entry shape");
}

const { tree: routeMap, stats: capabilityStats } = buildCliRouteTree({
  listings,
  annotations: toolAnnotations,
  entries: catalogEntries,
});
process.stderr.write(
  `Capability tree: ${capabilityStats.generated} namespaced leaves generated, ${capabilityStats.suppressed} suppressed (file transport), ${capabilityStats.flagCollisions.length} flag collision(s)\n`,
);
if (capabilityStats.flagCollisions.length > 0) {
  process.stderr.write(
    `  flag collisions (part-prefixed): ${capabilityStats.flagCollisions
      .map(({ id, flag }) => `${id}:${flag}`)
      .join(", ")}\n`,
  );
}

const annotationHeader = `/* oxlint-disable unicorn/numeric-separators-style -- generated JSON literals */
// GENERATED by \`bun run codegen\`. Do not edit by hand.
//
// API-owned CLI metadata projected from \`registry-snapshot.json\`. This keeps
// the runtime registry-refresh path on the same command-shaping metadata as the
// build-time route map without maintaining a second handwritten table.

import type { ToolAnnotation } from "../route-types.js";

export const generatedToolAnnotations: Readonly<Record<string, ToolAnnotation>> = `;

const annotationsWritten = await writeGeneratedFile({
  output: annotationOutputUrl,
  content: `${annotationHeader}${JSON.stringify(toolAnnotations, null, 2)};\n`,
});
if (Result.isError(annotationsWritten)) {
  process.stderr.write(`${annotationsWritten.error.message}\n`);
  process.exit(1);
}

process.stderr.write(`Wrote ${annotationOutputUrl.pathname}\n`);

const header = `/* oxlint-disable unicorn/numeric-separators-style -- generated JSON literals */
// GENERATED by \`bun run codegen\` (spec 051 S5.2). Do not edit by hand.
//
// The runtime route tree derived from the committed MCP registry and capability
// catalog. Build, tests, and typecheck regenerate this module before use.

import type { RouteNode } from "../route-types.js";

export const generatedRouteMap: RouteNode = `;

const routesWritten = await writeGeneratedFile({
  output: outputUrl,
  content: `${header}${JSON.stringify(routeMap, null, 2)};\n`,
});
if (Result.isError(routesWritten)) {
  process.stderr.write(`${routesWritten.error.message}\n`);
  process.exit(1);
}

process.stderr.write(`Wrote ${outputUrl.pathname}\n`);

if (runtimeOnly) {
  process.exit(0);
}

const { generateCliSkill, SKILL_NAME } = await import("./generate-skill.js");
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
    domains: capabilityDomainsOf(routeMap),
    tree: routeMap,
  }),
);
process.stderr.write(`Wrote ${skillUrl.pathname}\n`);

const { generateResourceTree } = await import("./generate-resource-tree.js");

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
