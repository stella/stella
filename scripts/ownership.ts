// Ownership rows live in scripts/ownership/<id>.ts. The lint config and
// generated per-row documents consume the same registry. --check validates
// paths and document freshness; --print renders the full table.

import { panic } from "better-result";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalModuleId } from "../.oxlint-plugins/module-id.ts";
// With its extension: oxlint.config.ts loads this file under Node's resolver.
import {
  formattedArtifactsLikeRepository,
  formattedLikeRepository,
} from "./generated-artifacts.ts";
import { loadOwnershipDeclarations } from "./ownership-loader.ts";
import type {
  AllowedFile,
  OwnershipEnforcement,
  OwnershipEntry,
} from "./ownership-types.ts";

export type {
  AllowedFile,
  OwnershipEnforcement,
  OwnershipEntry,
} from "./ownership-types.ts";
export { default as STATUS_TRANSITION_OWNERSHIP } from "./ownership/status-transition.ts";

// Computed filesystem reads retain these repository Markdown inputs.
export const CI_MARKDOWN_READER_INPUTS = [
  "docs/module-ownership.md",
  "docs/module-ownership/*.md",
];

export const SCHEMA_INTROSPECTION = [
  {
    path: "apps/api/scripts/generate-entity-feature-gate-propagation.ts",
    reason:
      "Renders static gate propagation SQL from full-schema metadata without database operations.",
  },
  {
    path: "apps/api/scripts/generate-status-tables.ts",
    reason: "Enumerates full-schema metadata without database operations.",
  },
  {
    path: "apps/api/src/db/schema.ts",
    reason: "Re-exports the schema declarations.",
  },
  {
    path: "apps/api/src/db/code-owned-tables.test.ts",
    reason: "Enumerates full-schema metadata without database operations.",
  },
  {
    path: "apps/api/src/db/high-volume-tables.test.ts",
    reason: "Enumerates full-schema metadata without database operations.",
  },
  {
    path: "apps/api/src/db/plan-guard-tables.test.ts",
    reason: "Enumerates full-schema metadata without database operations.",
  },
  {
    path: "apps/api/src/tests/security/schema-invariants.test.ts",
    reason: "Enumerates full-schema metadata without database operations.",
  },
  {
    path: "apps/api/src/tests/security/chat-derived-scope.test.ts",
    reason: "Enumerates full-schema metadata without database operations.",
  },
] as const satisfies readonly AllowedFile[];

const isSchemaEnforcement = (
  enforcement: OwnershipEnforcement,
  ownerPath: string,
): boolean =>
  enforcement.kind === "import" &&
  enforcement.specifiers.length > 0 &&
  enforcement.specifiers.every((specifier) => {
    const module = canonicalModuleId(specifier, ownerPath);
    return (
      module === "apps/api/src/db/schema" ||
      module.startsWith("apps/api/src/db/schema/")
    );
  });

// Materialize shared exceptions once, before either the lint rule or the
// documentation consumes the registry; new schema owners inherit them.
export const withSchemaIntrospection = (
  entry: OwnershipEntry,
): OwnershipEntry => {
  if (
    entry.enforcement.kind !== "import" ||
    !isSchemaEnforcement(
      entry.enforcement,
      entry.owner.at(0) ?? panic("Schema export ownership requires an owner"),
    )
  ) {
    return entry;
  }
  return {
    ...entry,
    enforcement: {
      ...entry.enforcement,
      allowed: [...entry.enforcement.allowed, ...SCHEMA_INTROSPECTION],
    },
  };
};

export const OWNERSHIP = loadOwnershipDeclarations(
  new URL("ownership/", import.meta.url),
).map(withSchemaIntrospection);

export const ROOT_CONNECTION_DOORS = OWNERSHIP.filter(
  (entry) => entry.group === "root-connection",
);

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOC_PATH = "docs/module-ownership.md";

const DOC_INTRO = `# Module ownership

One capability, one owning module. Each row is declared in
\`scripts/ownership/<id>.ts\` and documented in
[\`docs/module-ownership/<id>.md\`](module-ownership/). Add a new file, then run
\`bun scripts/ownership.ts --write\`; no shared index needs an edit.

Before adding a helper, module, or schema, search \`scripts/ownership/\`,
\`docs/module-ownership/\` and \`packages/*\`. Print the full table with
\`bun scripts/ownership.ts --print\`. Extend the owner, or say in the pull request why a second
implementation is correct.

Rows whose enforcement is not \`none\` are also read by the
\`confine-owner/confine-owner\` lint rule, which reports any linted file outside
the owner and its \`allowed\` list. Add a bypass by adding an \`allowed\` entry with a
reason, in the same row file.

Schema export owners inherit the exact files in \`SCHEMA_INTROSPECTION\`.
The ownership check follows their runtime dependencies and checks that they
only enumerate schema metadata. The ratchet measures each shared path;
additions require a justified allowance and removals are free.
`;

const ownerPathExists = (repoRoot: string, entryPath: string): boolean =>
  existsSync(path.join(repoRoot, entryPath));

const enforcementCell = (enforcement: OwnershipEnforcement): string => {
  switch (enforcement.kind) {
    case "none": {
      return "none";
    }
    case "import": {
      const specifiers = enforcement.specifiers.join("`, `");
      return enforcement.names === undefined
        ? `import \`${specifiers}\``
        : `import \`${enforcement.names.join("`, `")}\` from \`${specifiers}\``;
    }
    case "global-member": {
      return `global \`${[enforcement.object, ...enforcement.path].join(".")}\``;
    }
    case "member-call": {
      return `call \`.${enforcement.method}()\` in \`${enforcement.within.join("`, `")}\``;
    }
    case "function-call": {
      return `call \`${enforcement.name}()\` in \`${enforcement.within.join("`, `")}\``;
    }
    case "table-column-read": {
      const columns = enforcement.columns.map(
        (column) => `${enforcement.table}.${column}`,
      );
      return `read \`${columns.join("`, `")}\`, including implicit full-row selections`;
    }
    case "status-set": {
      return "lifecycle updates, conflict sets and visible SQL assignments; lint errors plus measured per-file backlog and shrink-only ratchet";
    }
    case "literal-pattern": {
      return `literal pattern \`${enforcement.pattern}\``;
    }
    default: {
      enforcement satisfies never;
      return panic(`Unhandled enforcement: ${String(enforcement)}`);
    }
  }
};

const allowedFiles = (
  enforcement: OwnershipEnforcement,
): readonly AllowedFile[] =>
  enforcement.kind === "none" ? [] : enforcement.allowed;

const allowedCell = (enforcement: OwnershipEnforcement): string => {
  const allowed = allowedFiles(enforcement);
  if (allowed.length === 0) {
    return "";
  }
  return ` (plus ${allowed.length} allowed ${allowed.length === 1 ? "file" : "files"})`;
};

export const renderOwnershipDocument = (
  entries: readonly OwnershipEntry[],
): string => `${DOC_INTRO}\n${renderOwnershipTable(entries)}`;

const renderOwnershipTable = (entries: readonly OwnershipEntry[]): string => {
  const rows = entries
    .toSorted((a, b) => {
      if (a.id === b.id) {
        return 0;
      }
      return a.id < b.id ? -1 : 1;
    })
    .map(
      ({ id, capability, owner, summary, enforcement }) =>
        `| \`${id}\` — ${capability} | ${owner.map((entryPath) => `\`${entryPath}\``).join(", ")} | ${enforcementCell(enforcement)}${allowedCell(enforcement)} | ${summary} |`,
    );
  return `| Capability | Owner | Enforcement | Summary |
| --- | --- | --- | --- |
${rows.join("\n")}
`;
};

export const validateOwnership = (
  entries: readonly OwnershipEntry[],
  repoRoot: string,
): readonly string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      problems.push(`duplicate ownership id: ${entry.id}`);
    }
    seen.add(entry.id);

    if (entry.enforcement.kind === "import") {
      const ownerPath = entry.owner.at(0);
      if (
        ownerPath !== undefined &&
        entry.enforcement.specifiers.some((specifier) => {
          const module = canonicalModuleId(specifier, ownerPath);
          return (
            module === "apps/api/src/db/schema" ||
            module.startsWith("apps/api/src/db/schema/")
          );
        }) &&
        !isSchemaEnforcement(entry.enforcement, ownerPath)
      ) {
        problems.push(
          `${entry.id}: schema imports require a separate ownership entry from other modules`,
        );
      }
    }

    for (const entryPath of entry.owner) {
      if (!ownerPathExists(repoRoot, entryPath)) {
        problems.push(`${entry.id}: owner path does not exist: ${entryPath}`);
      }
    }
    for (const allowed of allowedFiles(entry.enforcement)) {
      if (!ownerPathExists(repoRoot, allowed.path)) {
        problems.push(
          `${entry.id}: allowed path does not exist: ${allowed.path}`,
        );
      }
    }
  }

  return problems;
};

const main = async (argv: readonly string[]): Promise<number> => {
  if (argv.includes("--print")) {
    process.stdout.write(
      await formattedLikeRepository(renderOwnershipDocument(OWNERSHIP), "md"),
    );
    return 0;
  }

  if (!argv.includes("--write") && !argv.includes("--check")) {
    console.error(
      "Usage: bun scripts/ownership.ts --check | --write | --print",
    );
    return 1;
  }

  const artifacts = await formattedArtifactsLikeRepository([
    { path: DOC_PATH, contents: DOC_INTRO },
    ...OWNERSHIP.map((entry) => ({
      path: `docs/module-ownership/${entry.id}.md`,
      contents: `# ${entry.capability}\n\nGenerated from \`scripts/ownership/${entry.id}.ts\`. See [Module ownership](../module-ownership.md).\n\n${renderOwnershipTable([entry])}`,
    })),
  ]);
  const docDirectory = path.join(REPO_ROOT, "docs/module-ownership");
  const expected = new Set(artifacts.map(({ path: file }) => file));
  const obsolete = existsSync(docDirectory)
    ? readdirSync(docDirectory)
        .map((file) => `docs/module-ownership/${file}`)
        .filter((file) => !expected.has(file))
    : [];

  if (argv.includes("--write")) {
    mkdirSync(docDirectory, { recursive: true });
    for (const file of obsolete) {
      rmSync(path.join(REPO_ROOT, file));
    }
    for (const { path: file, contents } of artifacts) {
      writeFileSync(path.join(REPO_ROOT, file), contents);
    }
    console.log(
      `ownership: wrote ${artifacts.length} documents (${OWNERSHIP.length} rows).`,
    );
    return 0;
  }

  const { validateSchemaIntrospection } =
    await import("./schema-introspection.ts");
  const problems = [
    ...validateOwnership(OWNERSHIP, REPO_ROOT),
    ...validateSchemaIntrospection({
      entries: SCHEMA_INTROSPECTION,
      repoRoot: REPO_ROOT,
    }),
  ];
  for (const { path: file, contents } of artifacts) {
    const absolute = path.join(REPO_ROOT, file);
    if (!existsSync(absolute) || readFileSync(absolute, "utf-8") !== contents) {
      problems.push(
        `${file} is stale; regenerate with \`bun scripts/ownership.ts --write\``,
      );
    }
  }
  for (const file of obsolete) {
    problems.push(`obsolete ownership document: ${file}`);
  }

  if (problems.length > 0) {
    console.error("Module ownership check failed:");
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    return 1;
  }

  console.log(`ownership: OK (${OWNERSHIP.length} rows, ${DOC_PATH} current).`);
  return 0;
};

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
