// Ownership as data: one table naming the module that owns each capability.
//
// Three consumers read this table, so a row is a single decision rather than
// three synchronized edits:
//   - `.oxlint-plugins/confine-owner.ts` enforces the rows that carry an
//     `enforcement` kind, through the options `oxlint.config.ts` builds here.
//   - `docs/module-ownership.md` is rendered from it, so authors and agents
//     have one grep target before they write a second implementation.
//   - `--check` fails when the doc is stale, an id repeats, or a path a row
//     names has moved.
//
// Adding a row: name the capability, point `owner` at the paths that provide
// it, and say in `summary` why one owner and what callers get. Start at
// `kind: "none"`; move to an enforced kind once the bypass sites are gone.

import { panic } from "better-result";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A file the rule accepts besides the owner itself. `path` is a
// repo-relative file path, or a directory prefix ending in "/".
export type AllowedFile = {
  readonly path: string;
  readonly reason: string;
};

export type OwnershipEnforcement =
  | { readonly kind: "none" }
  | {
      readonly kind: "import";
      readonly specifiers: readonly string[];
      // When set, only an import of one of these bindings (or a namespace
      // import, which reaches all of them) is confined; the specifiers'
      // other exports stay open. For a package whose entry points also
      // carry unrelated exports.
      readonly names?: readonly string[];
      readonly allowed: readonly AllowedFile[];
    }
  | {
      readonly kind: "global-member";
      readonly object: string;
      // The member chain below `object`, e.g. `["clipboard", "writeText"]`
      // for `navigator.clipboard.writeText`. A sibling member of the same
      // object is a different capability and is not matched.
      readonly path: readonly string[];
      readonly allowed: readonly AllowedFile[];
    };

export type OwnershipEntry = {
  readonly id: string;
  readonly capability: string;
  readonly owner: readonly string[];
  readonly summary: string;
  readonly enforcement: OwnershipEnforcement;
};

export const OWNERSHIP = [
  {
    id: "redis-client",
    capability: "Valkey/Redis connections for ephemeral coordination",
    owner: ["apps/api/src/lib/redis-client.ts"],
    summary:
      "One module builds every Valkey client, so the uncapped reconnect ladder, " +
      "the error classification, and the connection options hold for all of them. " +
      "Valkey may carry only ephemeral coordination, and each allowed consumer " +
      "states the degraded path it takes during an outage.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/redis-client"],
      allowed: [
        {
          path: "apps/api/src/lib/bullmq-queue.ts",
          reason:
            "Queue transport. The shared facade owns lazy producer connections; BullMQ owns the key layout under its own prefix.",
        },
        {
          path: "apps/api/src/lib/document-deadline-scout-worker.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/document-processing-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/workflow-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/file-derivative-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/entity-deletion-cleanup-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/account-deletion-cleanup-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/style-set-package-cleanup-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/document-review/run-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/bilingual/run-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/document-translation/run-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/flows/flow-run-worker.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/scheduler/bullmq.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/handlers/reports/report-export-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/sse-broadcast.ts",
          reason:
            "Cross-instance SSE fan-out publisher. Lost messages degrade to inline local delivery.",
        },
        {
          path: "apps/api/src/lib/sse.ts",
          reason:
            "Cross-instance SSE fan-out subscriber. Lost messages degrade to inline local delivery.",
        },
        {
          path: "apps/api/src/lib/rate-limit/redis-context.ts",
          reason:
            "TTL'd rate-limit counters; degrades to a per-process fallback map when Valkey is unreachable.",
        },
        {
          path: "apps/api/src/lib/rate-limit/auth-storage.ts",
          reason:
            "TTL'd rate-limit counters; degrades to a per-process fallback map when Valkey is unreachable.",
        },
        {
          path: "apps/api/src/mcp/gateway/rate-limit.ts",
          reason:
            "TTL'd rate-limit counters; degrades to a per-process fallback map when Valkey is unreachable.",
        },
        {
          path: "apps/api/src/handlers/feedback/intake-guards.ts",
          reason:
            "TTL'd rate-limit counters; degrades to a per-process fallback map when Valkey is unreachable.",
        },
        {
          path: "apps/api/src/lib/security-canary.ts",
          reason:
            "TTL'd alert deduplication; an outage emits the alert rather than suppressing it.",
        },
        {
          path: "apps/api/src/lib/document-processing-readiness.ts",
          reason: "TTL'd OCR worker readiness lease; absence reads as unready.",
        },
        {
          path: "apps/api/src/lib/workflow/root-run-state-store.ts",
          reason:
            "Workflow run locks and progress counters, rebuilt from the durable orphan reconciler when they are lost.",
        },
        {
          path: "apps/api/src/lib/health/readiness.ts",
          reason: "Liveness probe: PINGs the connection it is reporting on.",
        },
        {
          path: "apps/api/src/handlers/case-law/ingestion/adapters/publisher-request-gate.ts",
          reason:
            "Publisher pacing: uses an expiring shared reservation, fails closed on a deployed outage to protect the publisher, and uses a process-local gate outside deployed environments.",
        },
      ],
    },
  },
  {
    id: "clipboard-write",
    capability: "Writing text to the system clipboard in the browser",
    owner: ["packages/clipboard/"],
    summary:
      "`navigator.clipboard.writeText` rejects on a denied permission or an " +
      "insecure context, and every call site owes the user that outcome. " +
      "`@stll/clipboard` wraps it in a `Result`, so callers branch on the " +
      "failure instead of each growing its own try/catch: `apps/web` toasts " +
      "and captures it, the `apps/landing` inline scripts leave the copy " +
      "button idle. oxlint does not scan `.astro`, so the landing side is " +
      "held by the `landing-inline-clipboard-writes` ratchet metric instead " +
      "of this rule.",
    enforcement: {
      kind: "global-member",
      object: "navigator",
      path: ["clipboard", "writeText"],
      allowed: [],
    },
  },
  {
    id: "app-urls",
    capability: "Links back into the web app from API responses",
    owner: ["apps/api/src/lib/mcp-connectors/app-urls.ts"],
    summary:
      "One module resolves the deployment's frontend origin and builds the " +
      "in-app paths an API response hands a person or an agent, so a link a " +
      "refusal or a tool result carries points at the same app on a " +
      "self-hosted deployment as on the hosted one. It lives beside the " +
      "connector/native-tool catalogue metadata: the catalogue entry page is " +
      "what these links mostly name, and the flat `apps/api/src/lib` bucket " +
      "only shrinks.",
    enforcement: { kind: "none" },
  },
  {
    id: "pagination-cursor-schema",
    capability: "Cursor query fields on list endpoints",
    owner: ["apps/api/src/lib/custom-schema.ts"],
    summary:
      "Cursor query fields come from `tPaginationCursor`, so the byte cap is " +
      "one named constant rather than a literal repeated per route.",
    enforcement: { kind: "none" },
  },
  {
    id: "object-storage",
    capability: "Object storage reads, writes, and presigned uploads",
    owner: ["apps/api/src/lib/s3.ts", "apps/api/src/lib/s3-presign.ts"],
    summary:
      "`s3.ts` owns the cancellable transport, credential resolution, and " +
      "response validation; `s3-presign.ts` owns the presigned PUT flow, which " +
      "signs size and checksum headers Bun's client cannot. The " +
      "`no-native-s3-object-read` and `no-native-s3-object-write` rules already " +
      "enforce this boundary.",
    enforcement: { kind: "none" },
  },
  {
    id: "transactional-email",
    capability: "Transactional email templates and delivery",
    owner: ["apps/api/src/lib/email/smtp.ts", "packages/transactional"],
    summary:
      "`smtp.ts` owns the transport, including the TLS requirement and the " +
      "credential-pair validation. `@stll/transactional` owns the templates and " +
      "their translations, so recipient-facing copy stays localized in one place.",
    enforcement: { kind: "none" },
  },
  {
    id: "pdf-rendering",
    capability: "Rendering an uploaded file to a PDF derivative",
    owner: ["apps/api/src/lib/files/gotenberg.ts"],
    summary:
      "One module talks to the conversion service, so the timeout, the " +
      "spreadsheet fit-to-page pre-processing, and the derivative policy that " +
      "decides which MIME types convert stay together.",
    enforcement: { kind: "none" },
  },
  {
    id: "docx-authoring",
    capability:
      "Producing DOCX bytes from Markdown, legal source, or a document model, and applying AI edits to a DOCX",
    owner: [
      "apps/api/src/lib/docx-authoring/",
      "apps/web/src/components/chat/create-document-compiler.ts",
    ],
    summary:
      "The compilers and the serialiser are external packages; the owner is the " +
      "one place that drives them, so every document stella writes carries its " +
      "house styles and the same edit attribution. Model-written Markdown goes " +
      "through `markdownToStellaDocx`, a draft in the legal-source markup through " +
      "`legalSourceToDocx`, a model built in this repository through " +
      "`stellaDocument` and `documentToDocx`, and AI edits through " +
      "`applyAiEditsToDocx`. The web owner compiles legal source for the " +
      "in-browser draft preview. None of this patches an existing template.",
    enforcement: {
      kind: "import",
      specifiers: [
        "@stll/docx-core",
        "@stll/folio-core",
        "@stll/folio-core/markdown",
        "@stll/folio-core/server",
      ],
      names: [
        "applyFolioAIEditsToBuffer",
        "compileLegalSourceToDocument",
        "compileLegalSourceToDocx",
        "createDocx",
        "fromMarkdown",
        "serializeDocumentToDocx",
      ],
      allowed: [
        {
          path: "apps/api/evals/create-document-drafting.ts",
          reason:
            "Scoring harness: compiles the model's legal source to read the compiler's own diagnostics (errors, fixes, warnings) and never writes a document.",
        },
      ],
    },
  },
  {
    id: "tanstack-chat-run",
    capability: "Starting a TanStack `chat()` run and reading its chunks",
    owner: ["apps/api/src/lib/chat/tanstack-chat-runtime.ts"],
    summary:
      "`chat()` emits AG-UI spec-shaped chunks: the engine keeps only the spec " +
      "keys of each event type and moves the rest into `metadata.tanstack`. " +
      "Two defects came from reading a moved key at the top level, so the owner " +
      "returns `PublicStreamChunk` — the same union without those keys — and " +
      "holds the readers that look in both places. A caller that reaches for " +
      "`chat()` itself gets the raw union back and the compile error with it.",
    enforcement: {
      kind: "import",
      specifiers: ["@tanstack/ai"],
      names: ["chat"],
      allowed: [],
    },
  },
  {
    id: "docx-template-patch",
    capability: "Rewriting OOXML parts inside an uploaded DOCX template",
    owner: ["apps/api/src/lib/docx/", "packages/docx-utils/"],
    summary:
      "Template patching edits the parts of a file a user supplied, preserving " +
      "everything it does not touch. It shares only the zip and namespace " +
      "helpers with `docx-authoring`. A third DOCX writer is not to be started.",
    enforcement: { kind: "none" },
  },
  {
    id: "relative-time",
    capability: "Relative and absolute time formatting in the web client",
    owner: ["apps/web/src/lib/relative-time.ts"],
    summary:
      "Relative-time output and the shared date/time format presets come from " +
      "one module bound to the active formatting locale, so a rendered instant " +
      "reads the same wherever it appears. The `require-relative-time-helpers` " +
      "rule enforces it.",
    enforcement: { kind: "none" },
  },
  {
    id: "money-arithmetic",
    capability: "Monetary amounts and minor-unit arithmetic",
    owner: ["packages/money/"],
    summary:
      "Amounts are stored and computed in minor units behind a `CentsAmount` " +
      "brand, so a major-unit value cannot be mixed into minor-unit math. The " +
      "brand threads from the Drizzle column through the API boundary into the " +
      "browser only while every producer mints it here.",
    enforcement: { kind: "none" },
  },
  {
    id: "money-minor-units",
    capability: "Converting between major and minor units of a currency",
    owner: ["packages/money/src/format.ts"],
    summary:
      "How many minor units make a major one is a property of the currency: " +
      "100 for USD, 1 for JPY, 1000 for KWD. `toMinorUnits`, `toMajorUnits`, " +
      "and `formatMoneyCents` all ask `currencyMinorUnitDigits` here, and the " +
      "`no-literal-minor-unit-scale` rule reports a money value scaled by a " +
      "literal 100 anywhere in `apps/*/src` or `packages/*/src`.",
    enforcement: { kind: "none" },
  },
  {
    id: "text-folding",
    capability: "Diacritic and ASCII folding for search and slugs",
    owner: ["packages/text-normalize/"],
    summary:
      "Folding decides which strings compare equal, so search, highlighting, " +
      "and slugs have to agree on it. Build slug helpers on the folds exported " +
      "here rather than on a local regex.",
    enforcement: { kind: "none" },
  },
  {
    id: "collation",
    capability: "Locale-aware sorting of human-readable text",
    owner: ["packages/collation/"],
    summary:
      "Constructing an `Intl.Collator` per comparison is a documented hot-path " +
      "cost, so the package caches one per locale behind a bounded LRU; " +
      "`require-cached-collator` routes every `localeCompare` through it.",
    enforcement: { kind: "none" },
  },
  {
    id: "stable-stringify",
    capability:
      "Deterministic string form of a JSON-shaped value for hashing and keys",
    owner: ["packages/stable-stringify/"],
    summary:
      "Sorted keys, cycle detection, and one spelling for bigint, symbol, and " +
      "function values, so a hash or cache key computed in the api and in the " +
      "browser agree byte for byte. `StableStringifyInput` is the contract: a " +
      "live Date, Map, or Set would read as `{}`, so it is a compile error " +
      "rather than a colliding fingerprint.",
    enforcement: { kind: "none" },
  },
  {
    id: "time",
    capability: "Calendar-date arithmetic, ISO date-only parsing, durations",
    owner: ["packages/time/"],
    summary:
      "A calendar day is not 24 hours across a DST transition, so moving to " +
      "another date goes through `addDays` and date-only strings are parsed " +
      'in local time by `parseIsoDateLocal`, never by `new Date("...")`. ' +
      "Elapsed-time math uses the duration constants instead. The " +
      "`no-raw-date-parsing` rule routes callers here.",
    enforcement: { kind: "none" },
  },
  {
    id: "user-agent",
    capability: "Browser and OS names parsed from a user-agent string",
    owner: ["packages/user-agent/"],
    summary:
      "One parser feeds session listings on the api and the device labels in " +
      "the web client, so a new browser family is recognised in both at once.",
    enforcement: { kind: "none" },
  },
] as const satisfies readonly OwnershipEntry[];

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOC_PATH = "docs/module-ownership.md";

const DOC_INTRO = `# Module ownership

One capability, one owning module. This file is generated from
\`scripts/ownership.ts\`; edit the table there, not here, then run
\`bun scripts/ownership.ts --write\`.

Before adding a helper, module, or schema, look for the capability below and in
\`packages/*\`. Extend the owner, or say in the pull request why a second
implementation is correct.

Rows whose enforcement is not \`none\` are also read by the
\`confine-owner/confine-owner\` lint rule, which reports any linted file outside
the owner and its \`allowed\` list. Add a bypass by adding an \`allowed\` entry with a
reason, in the same table.
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
): string => {
  const rows = entries.map(
    ({ id, capability, owner, summary, enforcement }) =>
      `| \`${id}\` — ${capability} | ${owner.map((entryPath) => `\`${entryPath}\``).join(", ")} | ${enforcementCell(enforcement)}${allowedCell(enforcement)} | ${summary} |`,
  );
  return `${DOC_INTRO}
| Capability | Owner | Enforcement | Summary |
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

const main = (argv: readonly string[]): number => {
  const rendered = renderOwnershipDocument(OWNERSHIP);
  const docFile = path.join(REPO_ROOT, DOC_PATH);

  if (argv.includes("--write")) {
    writeFileSync(docFile, rendered);
    console.log(`ownership: wrote ${DOC_PATH} (${OWNERSHIP.length} rows).`);
    return 0;
  }

  if (!argv.includes("--check")) {
    console.error("Usage: bun scripts/ownership.ts --check | --write");
    return 1;
  }

  const problems = [...validateOwnership(OWNERSHIP, REPO_ROOT)];
  const committed = existsSync(docFile) ? readFileSync(docFile, "utf-8") : "";
  if (committed !== rendered) {
    problems.push(
      `${DOC_PATH} is stale; regenerate with \`bun scripts/ownership.ts --write\``,
    );
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
  process.exit(main(process.argv.slice(2)));
}
