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

import { canonicalModuleId } from "../.oxlint-plugins/module-id.ts";
import { STATUS_COLUMNS } from "../apps/api/src/lib/db/status-tables.gen.ts";
import { SANCTIONS_MONITORING_TRANSITION_IDENTITIES } from "../apps/api/src/lib/lists/sanctions/monitoring-transition-identities.ts";
// With its extension: oxlint.config.ts loads this file under Node's resolver.
import { formattedLikeRepository } from "./generated-artifacts.ts";

const statusTransitionColumns = () => {
  const columns = new Map(
    Object.entries(STATUS_COLUMNS).map(([table, names]) => [
      table,
      new Set<string>(names),
    ]),
  );
  for (const { tableName, stateColumn } of Object.values(
    SANCTIONS_MONITORING_TRANSITION_IDENTITIES,
  )) {
    const names = columns.get(tableName) ?? new Set<string>();
    names.add(stateColumn);
    columns.set(tableName, names);
  }
  return Object.fromEntries(
    [...columns].map(([table, names]) => [table, [...names].toSorted()]),
  );
};

const STATUS_TRANSITION_COLUMNS = statusTransitionColumns();

// A file the rule accepts besides the owner itself. `path` is a
// repo-relative file path, or a directory prefix ending in "/".
export type AllowedFile = {
  readonly path: string;
  readonly reason: string;
};

export type OwnershipEnforcement =
  | { readonly kind: "none" }
  | {
      readonly kind: "literal-pattern";
      readonly pattern: string;
      readonly allowed: readonly AllowedFile[];
    }
  | {
      readonly kind: "status-set";
      readonly columns: Readonly<Record<string, readonly string[]>>;
      readonly allowed: readonly AllowedFile[];
    }
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
    }
  | {
      readonly kind: "member-call";
      // A call of this method on any receiver. The name alone is common, so
      // the rule applies only under the `within` path prefixes.
      readonly method: string;
      readonly within: readonly string[];
      readonly allowed: readonly AllowedFile[];
    }
  | {
      readonly kind: "function-call";
      readonly name: string;
      readonly within: readonly string[];
      readonly allowed: readonly AllowedFile[];
    };

export type OwnershipEntry = {
  readonly id: string;
  readonly capability: string;
  readonly owner: readonly string[];
  readonly summary: string;
  readonly enforcement: OwnershipEnforcement;
};

export const SCHEMA_INTROSPECTION = [
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

const FLUSHES_ITS_OWN_SEARCH_MARKS =
  "Flushes the search marks its own transaction committed.";

// The modules that hand the owner connection (`rootDb`) to other code on
// purpose. A worker host injects it into the workers it starts; every other
// row is a door: it runs one named owner operation for callers that hold no
// connection able to perform it, and exports that operation, never the
// connection. Its `allowed` list is the exact set of modules that may call
// it, enforced by `confine-owner`.
//
// `scripts/ratchet.ts` reads the owners below as the only files exempt from
// the `implicit-root-connection-shapes` metric (see
// `scripts/root-connection-shapes.ts`), so the lint allowlist and the metric's
// exemptions cannot drift apart. Adding a door here does not add a shape to
// the baseline; it moves one out of it, and review of the row is the gate.
export const ROOT_CONNECTION_DOORS = [
  {
    id: "desktop-account-renewal",
    capability: "Renewing account-bound desktop credentials",
    owner: ["apps/api/src/lib/business-registries/desktop/renewal.ts"],
    summary:
      "Renewal locks live membership and the purpose-bound credential, rotates its digest and inactivity deadline, and commits its audit in the same transaction. Recovery probes preserve the deadline.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/business-registries/desktop/renewal"],
      allowed: [
        {
          path: "apps/api/src/handlers/desktop-registry/renew.ts",
          reason: "Authorizes the native renewal or recovery request.",
        },
        {
          path: "apps/api/src/lib/business-registries/desktop/renewal.postgres.test.ts",
          reason: "Exercises the lifecycle with real database transactions.",
        },
      ],
    },
  },
  {
    id: "personal-api-key-lifecycle",
    capability: "Managing member-owned credentials in the denied auth table",
    owner: ["apps/api/src/lib/machine-api-keys/personal-lifecycle.ts"],
    summary:
      "Bounded lifecycle operations retain organization and owner SQL predicates, lock live membership, enforce policy and active-key limits, and audit within the mutation transaction. No raw database handle is exported.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/machine-api-keys/personal-lifecycle"],
      allowed: [
        {
          path: "apps/api/src/handlers/api-keys/personal/create.ts",
          reason: "Owns the session-authorized personal key operation.",
        },
        {
          path: "apps/api/src/handlers/api-keys/personal/list.ts",
          reason: "Owns the session-authorized personal key operation.",
        },
        {
          path: "apps/api/src/handlers/api-keys/personal/revoke.ts",
          reason: "Owns the session-authorized personal key operation.",
        },
        {
          path: "apps/api/src/handlers/api-keys/personal/rotate.ts",
          reason: "Owns the session-authorized personal key operation.",
        },
        {
          path: "apps/api/src/handlers/api-keys/personal/list-organization.ts",
          reason: "Owns the session-authorized personal key operation.",
        },
        {
          path: "apps/api/src/handlers/api-keys/personal/revoke-organization.ts",
          reason: "Owns the session-authorized personal key operation.",
        },
        {
          path: "apps/api/src/handlers/api-keys/personal/policy.ts",
          reason: "Owns the session-authorized personal key operation.",
        },
        {
          path: "apps/api/src/lib/machine-api-keys/personal-policy-reader.ts",
          reason: "Exposes only the read-only organization policy operation.",
        },
      ],
    },
  },
  {
    id: "operator-registration-directory",
    capability: "Serving audited operator registration pages",
    owner: ["apps/api/src/db/root.ts"],
    summary:
      "Reads bounded registration pages through the owner connection and records each read transactionally; callers receive only the declared directory fields, never a database handle.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/db/root"],
      names: ["readOperatorRegistrationPage"],
      allowed: [
        {
          path: "apps/api/src/handlers/operator/registrations.ts",
          reason:
            "Authorizes the deployment credential before reading the directory.",
        },
      ],
    },
  },

  {
    id: "personal-api-key-policy-reader",
    capability:
      "Reading personal API key policy during credential verification",
    owner: ["apps/api/src/lib/machine-api-keys/personal-policy-reader.ts"],
    summary:
      "The MCP authentication boundary can read policy without importing lifecycle mutations.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/machine-api-keys/personal-policy-reader"],
      allowed: [
        {
          path: "apps/api/src/mcp/api-key-auth.ts",
          reason: "Checks policy before accepting a personal credential.",
        },
      ],
    },
  },

  {
    id: "public-sanctions-reader-binding",
    capability:
      "Binding the public sanctions reader to the scoped connection pool",
    owner: ["apps/api/src/db/root.ts"],
    summary:
      "The connection owner constructs a column-restricted, read-only " +
      "sanctions reader without exporting another raw connection handle.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/db/root"],
      names: ["createPublicSanctionsReader"],
      allowed: [
        {
          path: "apps/api/src/lib/lists/sanctions/public-read-owner.ts",
          reason: "Owns the restricted anonymous screening handle.",
        },
      ],
    },
  },
  {
    id: "public-sanctions-screening",
    capability: "Reading the public sanctions corpus for anonymous screening",
    owner: ["apps/api/src/lib/lists/sanctions/public-read-owner.ts"],
    summary:
      "Anonymous screening uses a column-restricted reader role and read-only " +
      "transactions. This owner exports the restricted screening handle.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/lists/sanctions/public-read-owner"],
      allowed: [
        {
          path: "apps/api/src/handlers/sanctions/search.ts",
          reason: "Screens anonymous subjects against the public corpus.",
        },
      ],
    },
  },
  {
    id: "desktop-account-bootstrap",
    capability: "Claiming desktop connection and document handoff requests",
    owner: [
      "apps/api/src/lib/auth.ts",
      "apps/api/src/lib/business-registries/desktop/link-grants.ts",
      "apps/api/src/lib/business-registries/desktop/link-grant-store.ts",
      "apps/api/src/lib/desktop-edit-handoffs.ts",
    ],
    summary:
      "Connection verification rows deny application-role access. These owners " +
      "claim short-lived requests atomically, bind their stored account to the " +
      "request, and bootstrap live member scope before document access.",
    enforcement: {
      kind: "import",
      specifiers: [
        "@/api/lib/business-registries/desktop/link-grants",
        "@/api/lib/business-registries/desktop/link-grant-store",
        "@/api/lib/desktop-edit-handoffs",
      ],
      allowed: [
        {
          path: "apps/api/src/handlers/desktop-registry/grant.ts",
          reason: "Creates the authenticated browser connection request.",
        },
        {
          path: "apps/api/src/handlers/desktop-registry/redeem-link.ts",
          reason: "Claims the native connection request.",
        },
        {
          path: "apps/api/src/lib/business-registries/desktop/handoff-auth.ts",
          reason:
            "Records a terminal handoff acknowledgement before returning a protocol or account refusal.",
        },
        {
          path: "apps/api/src/handlers/entities/desktop-edit-handoffs.ts",
          reason: "Creates and claims document handoffs.",
        },
        {
          path: "apps/api/src/lib/business-registries/desktop/link-grants.test.ts",
          reason: "Exercises connection claims.",
        },
        {
          path: "apps/api/src/lib/desktop-edit-handoffs.integration.test.ts",
          reason: "Exercises document handoff claims.",
        },
      ],
    },
  },
  {
    id: "root-connection-worker-hosts",
    capability:
      "Handing the owner connection to the queue workers a process hosts",
    owner: [
      "apps/api/src/api-background-workers.ts",
      "apps/api/src/scripts/document-processing-worker.ts",
    ],
    summary:
      "Each process that runs BullMQ workers builds its host here and passes the " +
      "owner connection into every worker it starts (`BullMqWorkerContext.db`). " +
      "Workers take that handle as a required dependency and hand it to their " +
      "collaborators; none of them imports the connection itself.",
    enforcement: { kind: "none" },
  },
  {
    id: "flow-run-completion-notice",
    capability:
      "Notifying a flow run's actor when a reviewer completes the run",
    owner: ["apps/api/src/lib/flows/flow-run-completion-notice.ts"],
    summary:
      "Approving a run's last review gate completes a run whose actor is usually " +
      "another user. Resolving that actor and filing their notification are both " +
      "cross-user, so one operation does both on the owner connection, with the " +
      "recipient derived from the run and a run-keyed idempotency key.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/flows/flow-run-completion-notice"],
      allowed: [
        {
          path: "apps/api/src/lib/flows/flow-executor.ts",
          reason:
            "The review-gate resolver files the notice when an approval finishes the run.",
        },
        {
          path: "apps/api/src/handlers/fields/kanban-placement/update.ts",
          reason:
            "Kanban collects the resolver's run-derived notice and files it after its outer transaction commits.",
        },
      ],
    },
  },
  {
    id: "manual-ocr-request-run",
    capability: "Recording a user's manual OCR request",
    owner: ["apps/api/src/lib/entity-versions/manual-ocr-request-run.ts"],
    summary:
      "A manual OCR request may promote, retry or reuse a run another requester " +
      "or an upload owns, and cancels competing manual selections, in one " +
      "serialized transaction with the entity locked. Those updates are outside " +
      "the requester's scope, so the operation runs on the owner connection; " +
      "the helper it wraps takes its connection as a required argument.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/entity-versions/manual-ocr-request-run"],
      allowed: [
        {
          path: "apps/api/src/handlers/entities/ocr/create.ts",
          reason: "Records the manual OCR request the route accepted.",
        },
      ],
    },
  },
  {
    id: "search-projection-flush",
    capability: "Flushing a mutation's search marks after it commits",
    owner: ["apps/api/src/lib/search/projection-repair-flush.ts"],
    summary:
      "The repair queue and the search projections are system state that a " +
      "request scope cannot settle. These operations repair exactly the sources " +
      "the caller hands in, whose marks its own transaction committed; the " +
      "scheduled drain runs the same steps on the scheduler's own connection.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/search/projection-repair-flush"],
      allowed: [
        "apps/api/src/handlers/contacts/create.ts",
        "apps/api/src/handlers/contacts/delete.ts",
        "apps/api/src/handlers/contacts/import.ts",
        "apps/api/src/handlers/contacts/update.ts",
        "apps/api/src/handlers/entities/clip.ts",
        "apps/api/src/handlers/entities/copy.ts",
        "apps/api/src/handlers/entities/create.ts",
        "apps/api/src/handlers/entities/duplicate.ts",
        "apps/api/src/handlers/entities/rename-operation.ts",
        "apps/api/src/handlers/entities/versions/delete.ts",
        "apps/api/src/handlers/fields/kanban-placement/update.ts",
        "apps/api/src/handlers/signals/acceptances/create.ts",
        "apps/api/src/handlers/uploads/entity-create-tree.ts",
        "apps/api/src/handlers/workspaces/contacts/create.ts",
        "apps/api/src/handlers/workspaces/contacts/delete.ts",
        "apps/api/src/handlers/workspaces/create.ts",
        "apps/api/src/handlers/workspaces/duplicate.ts",
        "apps/api/src/handlers/workspaces/update.ts",
        "apps/api/src/lib/fields/write-field.ts",
        "apps/api/src/lib/flows/flow-executor.ts",
        "apps/api/src/lib/tasks/create-task-entity.ts",
      ].map((importer) => ({
        path: importer,
        reason: FLUSHES_ITS_OWN_SEARCH_MARKS,
      })),
    },
  },
  {
    id: "case-law-analysis-store",
    capability: "Storing a generated case-law decision analysis",
    owner: ["apps/api/src/lib/case-law/analysis-store.ts"],
    summary:
      "An analysis is global corpus state written from a background task that " +
      "outlives its request. The store's claim/save/clear operations are the " +
      "only way the generation handlers reach the row, and a deployment reading " +
      "a shared corpus never writes there.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/case-law/analysis-store"],
      allowed: [
        {
          path: "apps/api/src/handlers/case-law/analysis/generate.ts",
          reason: "Generates and stores a decision's analysis.",
        },
        {
          path: "apps/api/src/handlers/case-law/analysis/significance-run.ts",
          reason: "Stores the significance pass over an analysis.",
        },
      ],
    },
  },
  {
    id: "request-extraction-run-store",
    capability: "Recording the extraction run a request starts",
    owner: ["apps/api/src/lib/extraction-runs/request-run-store.ts"],
    summary:
      "`extraction_runs` admits no tenant writes, so a request that starts a " +
      "workflow records its run on the owner connection. The door exposes only " +
      "the transitions a starter performs before a worker holds the run " +
      "(create, start, skip, fail); workers pass the store their host built.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/extraction-runs/request-run-store"],
      allowed: [
        {
          path: "apps/api/src/handlers/playbooks/applicable/run.ts",
          reason: "Starts the workflow for the applicable playbooks it opened.",
        },
        {
          path: "apps/api/src/handlers/playbooks/run.ts",
          reason: "Starts the workflow for the playbook run it opened.",
        },
        {
          path: "apps/api/src/handlers/workspaces/cells/retry.ts",
          reason: "Starts the workflow that re-runs one cell.",
        },
        {
          path: "apps/api/src/handlers/workspaces/workflow/start.ts",
          reason: "Starts the workflow a caller asked for.",
        },
        {
          path: "apps/api/src/mcp/knowledge-tools.ts",
          reason: "Starts the workflow an agent tool asked for.",
        },
      ],
    },
  },
] as const satisfies readonly OwnershipEntry[];

// Model requests whose content never comes from a chat thread: documents,
// matters, templates, playbooks and public corpora, requested outside chat.
const MODEL_REQUESTS_WITHOUT_CHAT_CONTENT = [
  "apps/api/src/handlers/ai-autocomplete/stream.ts",
  "apps/api/src/handlers/case-law/analysis/generate.ts",
  "apps/api/src/handlers/case-law/analysis/significance-run.ts",
  "apps/api/src/handlers/case-law/decisions/search-expand.ts",
  "apps/api/src/handlers/case-law/decisions/search-refine.ts",
  "apps/api/src/handlers/case-law/polarity/llm-classifier.ts",
  "apps/api/src/handlers/clauses/rewrite.ts",
  "apps/api/src/handlers/contacts/extract-procuracao.ts",
  "apps/api/src/handlers/document-reviews/reference-positions.ts",
  "apps/api/src/handlers/entities/placements/suggest.ts",
  "apps/api/src/handlers/playbooks/derive-ask.ts",
  "apps/api/src/handlers/search/ai.ts",
  "apps/api/src/handlers/skills/drafts/generate.ts",
  "apps/api/src/handlers/skills/proposals/from-comments/create.ts",
  "apps/api/src/handlers/skills/resources/rewrite.ts",
  "apps/api/src/handlers/templates/prefill.ts",
  "apps/api/src/handlers/time-entries/polish-narrative.ts",
  "apps/api/src/lib/ai-change-summary.ts",
  "apps/api/src/lib/bbox/ai-generate-b-boxes.ts",
  "apps/api/src/lib/bilingual/ai.ts",
  "apps/api/src/lib/case-law/research-answer-runner.ts",
  "apps/api/src/lib/document-review/parties.ts",
  "apps/api/src/lib/document-review/reference-grade.ts",
  "apps/api/src/lib/document-translation/ai.ts",
  "apps/api/src/lib/flows/flow-executor.ts",
  "apps/api/src/lib/lists/verification/model-call.ts",
  "apps/api/src/lib/properties/column-prompt-suggestion.ts",
  "apps/api/src/lib/scouts/document-deadlines.ts",
  "apps/api/src/lib/workflow/ai-generate-batch.ts",
  "apps/api/src/lib/workflow/verdict-engine.ts",
] as const;

// Recognises a model request that stayed off the table below.
const MODEL_REQUEST_NAMES = [
  "collectTanStackTextRun",
  "generateChatObject",
  "generateTanStackChatObject",
  "generateTanStackObjectForRole",
  "generateTanStackTextForRole",
  "streamChatChunks",
  "streamChatObject",
  "streamTanStackChatRun",
  "streamTanStackObjectForRole",
  "streamTanStackTextForRole",
] as const;

// The engine's raw run forms. Their failures carry provider and model text, so
// only the modules that project them to fixed-message errors call them.
const RAW_MODEL_RUN_NAMES = [
  "generateChatObject",
  "streamChatChunks",
  "streamChatObject",
] as const;

export const STATUS_TRANSITION_OWNERSHIP = {
  id: "status-transition",
  capability: "Changing a row's lifecycle state",
  owner: ["apps/api/src/lib/db/transitions.ts"],
  summary:
    "The transition owner checks the expected state and optional fence in the update predicate, and returns Transitioned or Stale. A required recorder audits successful updates in the caller's transaction; stale updates record nothing and recorder failure rolls the update back. Direct lifecycle writes, conflict updates and visible SQL lifecycle assignments are lint errors outside the measured backlog; per-file shrink-only guards forbid adding them. Opaque table handles and payloads count conservatively. Unmanaged declarations shrink independently per table. SQL built entirely by external functions, external payload mutation and custom SQL column names not ending in status/state/phase remain outside static inspection.",
  enforcement: {
    kind: "status-set",
    columns: STATUS_TRANSITION_COLUMNS,
    allowed: [],
  },
} as const satisfies OwnershipEntry;
// Case-law modules that still call the raw publisher fetch. Each migrates to
// `readPublisher` and leaves this list; nothing is added to it.
const UNMIGRATED_PUBLISHER_READERS = [
  "handlers/case-law/ingestion/adapters/at-findok-throttle.ts",
  "handlers/case-law/ingestion/adapters/at-ris-throttle.ts",
  "handlers/case-law/ingestion/adapters/eu-ecj.ts",
  "handlers/case-law/ingestion/adapters/hu-bhgy.ts",
  "handlers/case-law/ingestion/adapters/pagination.ts",
  "handlers/case-law/ingestion/adapters/pl-courts.ts",
  "handlers/case-law/ingestion/adapters/pl-kio.ts",
  "handlers/case-law/ingestion/adapters/pl-kis.ts",
  "handlers/case-law/ingestion/adapters/pl-ncourt.ts",
  "handlers/case-law/ingestion/adapters/pl-nsa-dataset.ts",
  "handlers/case-law/ingestion/adapters/pl-sn.ts",
  "handlers/case-law/ingestion/adapters/pl-tk.ts",
  "handlers/case-law/ingestion/adapters/pl-uodo.ts",
  "handlers/case-law/ingestion/adapters/pl-uokik.ts",
  "handlers/case-law/ingestion/adapters/sk-collections.ts",
] as const;

const OWNERSHIP_DECLARATIONS = [
  STATUS_TRANSITION_OWNERSHIP,
  {
    id: "desktop-presence-observations",
    capability: "Reading and retaining desktop presence observations",
    owner: ["apps/api/src/handlers/desktop-presence/service.ts"],
    summary:
      "The service serializes reports against live membership and retains ten newest installations per organization and user. Offboarding clears observations in its membership transaction.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/db/schema", "@/api/db/schema/desktop-presence"],
      names: ["desktopPresence"],
      allowed: [
        {
          path: "apps/api/src/lib/member-assignment-offboarding.ts",
          reason: "Clears observations during organization membership removal.",
        },
      ],
    },
  },
  {
    id: "citation-graph-transaction",
    capability: "Acquiring the citation graph transaction lock",
    owner: ["apps/api/src/handlers/case-law/citation-graph-transaction.ts"],
    summary:
      "The graph owner acquires its advisory lock before domain row locks and passes a branded transaction to graph writers. The conditional owner declines busy walks before reading their cursor.",
    enforcement: {
      kind: "literal-pattern",
      pattern: "citation_resolution_walk",
      allowed: [
        {
          path: "scripts/ownership.ts",
          reason: "Declares the confined lock key.",
        },
        {
          path: "apps/api/src/handlers/case-law/citation-graph-transaction.test.ts",
          reason: "Checks graph admission and failed acquisition.",
        },
        {
          path: "apps/api/src/handlers/case-law/ingestion/citation-graph-lock-order.postgres.test.ts",
          reason: "Exercises graph lock ordering and the rejecting mutation.",
        },
        {
          path: ".oxlint-plugins/__tests__/confine-owner.test.ts",
          reason:
            "Exercises rejected literal and SQL fixtures through the lint rule.",
        },
      ],
    },
  },
  {
    id: "task-assignment-membership",
    capability: "Writing task assignments for current matter members",
    owner: [
      "apps/api/src/lib/tasks/assignment-membership.ts",
      "apps/api/src/lib/member-assignment-offboarding.ts",
      "apps/api/src/lib/account-deletion-steps.ts",
    ],
    summary:
      "Assignment writes validate held memberships in their write transaction. Removal clears assignments with former-assignee audit, preserving the task. Matter locks precede workflow run, step, obligation and entity locks; organization offboarding takes its organization membership before the matter prefix.",
    enforcement: {
      kind: "import",
      specifiers: [
        "@/api/db/schema",
        "@/api/db/schema/entities",
        "apps/api/src/db/schema/entities.ts",
      ],
      names: ["taskAssignees"],
      allowed: [
        {
          path: "apps/api/src/db/",
          reason: "Schema and relation declarations.",
        },
        {
          path: "apps/api/src/lib/entities/query-entities.ts",
          reason: "Read assignment projection.",
        },
        {
          path: "apps/api/src/lib/tasks/assigned.ts",
          reason: "Read assignment filters.",
        },
        {
          path: "apps/api/src/lib/work-obligations/legacy-work-obligation.ts",
          reason: "Read legacy ownership projection.",
        },
        {
          path: "apps/api/src/lib/scheduler/tasks/work-obligation-backfill.ts",
          reason: "Read assignment source for obligation backfill.",
        },
        {
          path: "apps/api/src/mcp/matter-tools.ts",
          reason: "Read task detail projection.",
        },
      ],
    },
  },
  {
    id: "feature-access",
    capability: "Deciding caller feature admission and discovery",
    owner: [
      "apps/api/src/lib/auth/feature-access/policy.ts",
      "apps/api/src/lib/auth/feature-access/context.ts",
      "apps/api/src/lib/feature-access/registry.ts",
      "apps/api/src/mcp/feature-access.ts",
    ],
    summary:
      "The feature registry declares enrolment and ownership. One principal-bound policy decides admission and discovery; the catalog declaration guard and real discovery tests enforce the boundary.",
    enforcement: { kind: "none" },
  },
  {
    id: "time-entry-amount",
    capability: "Price recorded time with its no-charge disposition",
    owner: ["packages/money/"],
    summary:
      "timeEntryAmount requires the noCharge field and returns zero for no-charge time. " +
      "Invoice lines, exports and displayed time amounts use this calculation.",
    enforcement: {
      kind: "import",
      specifiers: ["@stll/money"],
      names: ["prorateHourlyCents"],
      allowed: [],
    },
  },
  {
    id: "deepl-availability",
    capability: "Reading translation provider availability on demand",
    owner: ["apps/web/src/components/translate-document-dialog.tsx"],
    summary:
      "The translation dialog starts availability reads only while open. Its shared query factory requires an explicit open state, keys the cache by organization, and lets an in-flight read complete across toolbar remounts.",
    enforcement: {
      kind: "import",
      specifiers: ["@/lib/deepl/queries"],
      names: ["deepLAvailabilityOptions"],
      allowed: [],
    },
  },
  {
    id: "query-view",
    capability: "Presenting non-suspense query results",
    owner: [
      "apps/web/src/lib/query-view.logic.ts",
      "apps/web/src/lib/use-query-view.ts",
    ],
    summary:
      "useQueryView separates pending reads, initial errors with retry, successful empty results and cached items with refetch errors. The query-data-requires-state lint rule rejects data reads without state handling and hooks that discard query state; its exact-set baseline only shrinks.",
    enforcement: { kind: "none" },
  },
  {
    id: "entity-sibling-naming",
    capability: "Resolving names for new sibling entities",
    owner: [
      "apps/api/src/lib/entities/sibling-name.ts",
      "apps/api/src/lib/entities/sibling-name-insert.ts",
    ],
    summary:
      "The insert owner reads current matter and parent names, reserves pending batch names, and supplies a resolved display name plus a derived sanitized file name to single and batch inserts. The existing typed extraction-file selector identifies each current version's primary file; secondary attachment names remain independent. The pure producer is confined to that owner so callers cannot substitute an empty sibling set.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/entities/sibling-name"],
      names: ["resolveSiblingName"],
      allowed: [],
    },
  },
  {
    id: "provider-event-records",
    capability: "Minimal verified provider event persistence",
    owner: [
      "apps/api/src/lib/hosted-usage-provider/webhook-store.ts",
      "apps/api/src/handlers/hosted-usage-webhook/replay.ts",
    ],
    summary:
      "The store projects authenticated deliveries through the dispatch schema before persistence. Retention redacts completed details while preserving deduplication identifiers and unresolved records.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/db/schema", "@/api/db/schema/usage"],
      names: ["hostedUsageWebhookEvents"],
      allowed: [
        {
          path: "apps/api/src/tests/pglite-test-db.ts",
          reason:
            "Schema export or full-schema test introspection; no production receipt writer.",
        },
        {
          path: "apps/api/src/tests/security/test-utils.ts",
          reason:
            "Schema export or full-schema test introspection; no production receipt writer.",
        },
        {
          path: "apps/api/src/tests/pglite-role-grants.test.ts",
          reason:
            "Schema export or full-schema test introspection; no production receipt writer.",
        },
        {
          path: "apps/api/src/lib/account-deletion-coverage.test.ts",
          reason:
            "Schema export or full-schema test introspection; no production receipt writer.",
        },
        {
          path: "apps/api/src/lib/workspace-deletion-coverage.test.ts",
          reason:
            "Schema export or full-schema test introspection; no production receipt writer.",
        },
        {
          path: "apps/api/src/lib/workflow/straggler-catchup.db.test.ts",
          reason:
            "Schema export or full-schema test introspection; no production receipt writer.",
        },
        {
          path: "apps/api/src/lib/entity-filters.differential.test.ts",
          reason:
            "Schema export or full-schema test introspection; no production receipt writer.",
        },
        {
          path: "apps/api/src/handlers/hosted-usage-webhook/receive.test.ts",
          reason: "Asserts the persisted delivery projection.",
        },
        {
          path: "apps/api/src/handlers/hosted-usage-webhook/contract.postgres.test.ts",
          reason: "Asserts dispatch and receipt outcomes in PostgreSQL.",
        },
        {
          path: "apps/api/src/lib/hosted-usage-provider/replay.postgres.test.ts",
          reason:
            "Asserts selected receipt replay and durable audit outcomes in PostgreSQL.",
        },
        {
          path: "apps/api/src/lib/hosted-usage-provider/webhook-retention.postgres.test.ts",
          reason: "Asserts retention against isolated PostgreSQL receipts.",
        },
      ],
    },
  },
  {
    id: "legislation-revision-row-write",
    capability: "Persisting a legislation revision's body and version metadata",
    owner: ["apps/api/src/handlers/legislation/ingestion.ts"],
    summary:
      "The ingestion owner publishes revision values together. " +
      "`no-direct-legislation-revision-write` rejects separate row mutations; " +
      "withdrawal, expression-ID backfill and projection-epoch owners may update " +
      "only their exact unrelated columns through explicit object literals.",
    enforcement: { kind: "none" },
  },
  {
    id: "legislation-revision-corpus-write",
    capability: "Writing a legislation revision's corpus payload",
    owner: ["apps/api/src/handlers/legislation/revision.ts"],
    summary:
      "The revision owner writes the normalized payload that its metadata describes. " +
      "Ingestion supplies a complete revision; callers cannot independently replace its corpus body.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/legal-search/corpus-storage"],
      names: ["writeCorpusDocument"],
      allowed: [
        {
          path: "apps/api/src/lib/legal-search/corpus-pack-batch.ts",
          reason:
            "The shared corpus maintenance writer republishes stored payloads across both document families.",
        },
      ],
    },
  },
  {
    id: "api-test-memory-planner",
    capability: "Measured API test memory and batch composition",
    owner: ["apps/api/scripts/test-batch-plan.ts"],
    summary:
      "The planner owns measured peak RSS, conservative unknown weights and automatic process isolation. Batch plans must fit their execution-class memory caps before a test starts.",
    enforcement: {
      kind: "import",
      specifiers: ["apps/api/scripts/test-peak-rss.json"],
      allowed: [],
    },
  },
  {
    id: "model-request-send-mode",
    capability: "Sending a request to an AI model",
    owner: [
      "apps/api/src/lib/tanstack-ai-generate.ts",
      "apps/api/src/lib/chat/tanstack-chat-runtime.ts",
    ],
    summary:
      "Every request to a model decides how a chat thread's send mode " +
      "applies to what it carries. The chat turn, its subagents and its " +
      "compaction prepare their payload through " +
      "`handlers/chat/third-party-boundary.ts`. A request built from a " +
      "thread's stored content outside the turn (a title, a recap, " +
      "suggestions, a background summary, memory extraction) reads " +
      "`readThreadStoredContentSendModeOnTx` after loading that content and " +
      "sends nothing for a thread that used anonymized mode. The rest carry " +
      "no chat content. A new caller joins this list with its decision.",
    enforcement: {
      kind: "import",
      specifiers: [
        "@/api/lib/tanstack-ai-generate",
        "@/api/lib/chat/tanstack-chat-runtime",
      ],
      names: MODEL_REQUEST_NAMES,
      allowed: [
        {
          path: "apps/api/src/handlers/chat/stream-chat.ts",
          reason:
            "The chat turn: messages, system text, tools and resumed payloads pass through the turn's third-party boundary right before the request.",
        },
        {
          path: "apps/api/src/handlers/chat/subagent-runner.ts",
          reason:
            "A subagent's brief, messages and tools pass through the parent turn's boundary.",
        },
        {
          path: "apps/api/src/handlers/chat/compaction.ts",
          reason:
            "In-turn compaction: the transcript passes through the turn's boundary, or is already the boundary's output inside the run.",
        },
        {
          path: "apps/api/src/handlers/chat/generate-thread-title.ts",
          reason:
            "Titles a new thread from its first raw turn; reads the thread's send mode right before sending.",
        },
        {
          path: "apps/api/src/handlers/chat/suggest-thread-title.ts",
          reason:
            "Sends the window `loadRecapMessageWindow` returns, which reads the send mode after the messages.",
        },
        {
          path: "apps/api/src/handlers/chat/get-suggested-prompts.ts",
          reason:
            "Sends the window `loadRecapMessageWindow` returns, which reads the send mode after the messages.",
        },
        {
          path: "apps/api/src/handlers/chat/thread-recap.ts",
          reason:
            "Recaps the window `loadRecapMessageWindow` returns, which reads the send mode after the messages.",
        },
        {
          path: "apps/api/src/handlers/chat/improve-prompt.ts",
          reason:
            "Sends only the composer text, and refuses a request in anonymized mode.",
        },
        {
          path: "apps/api/src/lib/chat/thread-compaction.ts",
          reason:
            "Background summary: reads the send mode after the delta and again under the checkpoint lock.",
        },
        {
          path: "apps/api/src/lib/scheduler/tasks/memory-extractor.ts",
          reason:
            "Claims skip anonymized threads; reads the send mode after the transcript, right before sending.",
        },
        {
          path: "apps/api/src/lib/docx/ai-field-generator.ts",
          reason:
            "Template AI fields: chat's fill_template sends their prompts and values through the turn's boundary; the fill routes carry no chat content.",
        },
        {
          path: "apps/api/src/lib/templates/suggest-template-fields.ts",
          reason:
            "Chat's suggest_template_fields prepares the text through the turn's boundary first; the template routes carry no chat content.",
        },
        ...MODEL_REQUESTS_WITHOUT_CHAT_CONTENT.map((modulePath) => ({
          path: modulePath,
          reason: "Carries no chat content.",
        })),
        {
          path: "apps/api/evals/",
          reason: "Offline evaluations over fixture conversations.",
        },
        {
          path: "apps/api/scripts/ai-native-image-canary.ts",
          reason: "Provider canary with synthetic content.",
        },
        {
          path: "apps/api/scripts/ai-provider-canary.ts",
          reason: "Provider canary with synthetic content.",
        },
        {
          path: "apps/api/scripts/ai-provider-cassette-probe.ts",
          reason: "Records provider cassettes from synthetic prompts.",
        },
        {
          path: "apps/api/scripts/benchmark-chat-read-surface.ts",
          reason: "Benchmark with synthetic content.",
        },
      ],
    },
  },
  {
    id: "desktop-http-client",
    capability: "Identified native desktop HTTP clients",
    owner: ["apps/desktop/src-tauri/src/http_client.rs"],
    summary:
      "DesktopHttpClient is the only constructor for native desktop HTTP. " +
      "It always supplies the desktop User-Agent; Clippy bans raw reqwest Client/ClientBuilder " +
      "types and constructors outside this owner, including aliases and Default paths. " +
      "Local HTTP tests exercise the outgoing headers across configuration choices.",
    enforcement: { kind: "none" },
  },
  {
    id: "desktop-account",
    capability: "Desktop account link and credential lifecycle",
    owner: ["apps/desktop/src-tauri/src/account.rs"],
    summary:
      "One Keychain record holds account identity and its validated credential. " +
      "Settings and registry search read the same account; expiry, revocation and disconnect " +
      "cannot leave a profile-only connected state. The credential lifetime and prefix " +
      "are derived from the API contract policy shared with the server.",
    enforcement: { kind: "none" },
  },
  {
    id: "schema-form-options",
    capability: "Web form validation and submission normalization",
    owner: ["apps/web/src/lib/schema.ts"],
    summary:
      "schemaFormOptions wires dynamic validation and requires a schema-output or raw submission choice. " +
      "Valibot owns field transformations; callbacks receive the selected input or output type. " +
      "require-schema-form-options routes every production web form through this contract.",
    enforcement: { kind: "none" },
  },
  {
    id: "unsaved-work",
    capability: "Guarding unsaved local work in the web app",
    owner: ["apps/web/src/hooks/use-unsaved-work.ts"],
    summary:
      "useUnsavedWork registers a named surface while it is dirty and installs the route blocker and unload prompt its guard asks for. " +
      "The stale-client refresh reads hasUnsavedWork() before reloading, so work guarded anywhere else would be reloaded over. " +
      "no-direct-unsaved-work-guard rejects TanStack blockers and beforeunload listeners outside the owner.",
    enforcement: { kind: "none" },
  },
  {
    id: "pinned-workspace-handles",
    capability: "Database handles pinned to stored workspace ids",
    owner: ["apps/api/src/lib/root-scoped-db.ts"],
    summary:
      "A pinned handle reaches the workspaces it names whether or not its user " +
      "is still a member of them, so it is built only for writes and lookups an " +
      "earlier check already proved. A run a member queued goes through " +
      "`createRootRunActor` instead, whose pinned `writeDb` the document, file " +
      "and field readers (`ContentReadDb`) refuse. " +
      "`createRootOrganizationBackgroundDb` validates the organization id and " +
      "binds background work to that organization with no user or stored workspace ids.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/root-scoped-db"],
      names: ["createRootScopedDb", "createRootSafeDb"],
      allowed: [
        {
          path: "apps/api/src/handlers/case-law/research/answers-run.ts",
          reason:
            "A research run that outlives its request, pinned to no workspace.",
        },
        {
          path: "apps/api/src/handlers/uploads/entity-version.ts",
          reason: "Computes diff stats for the version the upload just wrote.",
        },
        {
          path: "apps/api/src/lib/business-registries/desktop/link-grants.ts",
          reason: "Scopes a claimed desktop connection to its stored grant.",
        },
        {
          path: "apps/api/src/lib/desktop-edit-sessions.ts",
          reason: "Writes back through a live desktop editing session.",
        },
        {
          path: "apps/api/src/lib/email/inbound/runtime.ts",
          reason: "Files inbound mail into the matter its routing resolved.",
        },
        {
          path: "apps/api/src/lib/email/inbound/upload.ts",
          reason:
            "Files an email file as its uploader, whose matter access the filing transaction rechecks.",
        },
        {
          path: "apps/api/src/lib/entity-versions/create-entity-version-from-buffer.ts",
          reason: "Writes a new version into a workspace its caller proved.",
        },
        {
          path: "apps/api/src/lib/file-derivative-queue.ts",
          reason: "Derivative generation is organization automation.",
        },
        {
          path: "apps/api/src/lib/files/pdf-signing/sessions.ts",
          reason: "Scopes a signing session to its stored workspace.",
        },
        {
          path: "apps/api/src/lib/flows/flow-executor.ts",
          reason:
            "Flow steps, a member run not yet on the run actor (scripts/queue-authority-baseline.json).",
        },
        {
          path: "apps/api/src/lib/folio-collab-rooms.ts",
          reason:
            "Persists a collaboration room re-checked on every token use.",
        },
        {
          path: "apps/api/src/lib/scheduler/tasks/work-attention-scout.ts",
          reason: "Scheduled organization automation.",
        },
        {
          path: "apps/api/src/lib/scouts/document-deadlines.ts",
          reason: "Scheduled organization automation.",
        },
        {
          path: "apps/api/src/lib/scouts/work-attention.ts",
          reason: "Takes the constructor as an injected dependency type.",
        },
      ],
    },
  },
  {
    id: "member-run-actor",
    capability: "Acting for the member who queued a run",
    owner: ["apps/api/src/lib/root-scoped-db.ts"],
    summary:
      "`createRootRunActor` splits a queued run's authority: `writeDb` keeps the " +
      "workspace pinned for the run's own rows and its output, and `inputDb` " +
      "reads under the requester's membership as it stands when the run " +
      "executes. Member-run queues and scheduler tasks are listed in " +
      "`apps/api/src/lib/member-run-queues.ts`.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/root-scoped-db"],
      names: ["createRootRunActor"],
      allowed: [
        // Kept equal to MEMBER_RUN_QUEUES by scripts/ownership.test.ts.
        ...[
          "apps/api/src/lib/document-review/run-queue.ts",
          "apps/api/src/lib/document-translation/run-queue.ts",
          "apps/api/src/lib/bilingual/run-queue.ts",
          "apps/api/src/handlers/reports/report-export-queue.ts",
          "apps/api/src/lib/lists/verification/run-queue.ts",
          "apps/api/src/lib/workflow-queue.ts",
        ].map((modulePath) => ({
          path: modulePath,
          reason: "Member run; reads its inputs through inputDb.",
        })),
        // Kept equal to MEMBER_RUN_SCHEDULER_TASKS by scripts/ownership.test.ts.
        {
          path: "apps/api/src/lib/scheduler/tasks/memory-extractor.ts",
          reason:
            "Member-run scheduler task; reads each compaction through its owner's inputDb.",
        },
      ],
    },
  },
  {
    id: "admission-redis",
    capability: "Non-evicting admission coordination",
    owner: [
      "apps/api/src/lib/admission-redis.ts",
      "apps/api/src/lib/non-evicting-redis.ts",
    ],
    summary:
      "Admission, reservations, and fences use a checked command facade. A reported evicting policy refuses work; uninspectable policies warn. These callers cannot import the unchecked connection factory.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/admission-redis"],
      allowed: [
        {
          path: "apps/api/src/lib/rate-limit/action-admission.ts",
          reason:
            "Shared concurrency leases, period reservations, and service budgets.",
        },
        {
          path: "apps/api/src/lib/rate-limit/mcp-read-fence.ts",
          reason: "Shared emitted-byte windows and cancellation fences.",
        },
        {
          path: "apps/api/src/handlers/case-law/ingestion/adapters/publisher-request-gate.ts",
          reason: "Shared publisher pacing reservations and cooldowns.",
        },
      ],
    },
  },
  {
    id: "redis-client",
    capability: "Valkey/Redis connections for ephemeral coordination",
    owner: ["apps/api/src/lib/redis-client.ts"],
    summary:
      "The API factory requires a storage class for every client and owns the " +
      "reconnect ladder, error classification, and connection options. " +
      "Shared policy inspection covers durable coordination; the construction " +
      "guard checks both the API and collaboration factories. " +
      "Valkey may carry only ephemeral coordination, and each allowed consumer " +
      "states the degraded path it takes during an outage.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/redis-client"],
      allowed: [
        {
          path: "apps/api/src/lib/admission-redis.ts",
          reason:
            "Admission clients check and periodically refresh the non-eviction policy before issuing coordination commands.",
        },
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
          path: "apps/api/src/lib/email/inbound/upload-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/document-review/run-queue.ts",
          reason:
            "Queue transport: worker owns its dedicated blocking connection.",
        },
        {
          path: "apps/api/src/lib/lists/verification/run-queue.ts",
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
    id: "bounded-export-read",
    capability: "Reading a complete set within an export row cap",
    owner: ["apps/api/src/lib/db/read-bounded.ts"],
    summary:
      "`readBounded` applies a cap-plus-one SQL limit and returns either the " +
      "complete rows or an explicit overflow result without a partial set. " +
      "`readCursorPage` uses the same sentinel and the existing `Page` owner " +
      "to preserve worker continuation without claiming a partial set is complete. " +
      "This owner handles expected export ceilings; `boundedAll` instead " +
      "panics when a write-path cardinality invariant is violated. " +
      "`scripts/transfer-read-guard.ts` enumerates fixed-limit reads and " +
      "enforces their shrink-only migration baseline.",
    enforcement: { kind: "none" },
  },
  {
    id: "fetch-transfer-timeout",
    capability: "Applying response header and body idle deadlines",
    owner: ["packages/fetch/src/index.ts"],
    summary:
      "`@stll/fetch` requires a header or idle timeout policy for new callers " +
      "and composes caller cancellation. Idle deadlines cover pending body reads; " +
      "header deadlines stop at the response. Deprecated numeric callers and " +
      "raw total deadlines on body reads are enumerated by " +
      "`scripts/transfer-read-guard.ts` with a shrink-only baseline.",
    enforcement: { kind: "none" },
  },
  {
    id: "case-law-source-fingerprint",
    capability:
      "The change-detection hash of a case-law decision's stored source",
    owner: ["apps/api/src/handlers/case-law/ingestion/source-fingerprint.ts"],
    summary:
      "`sourceFingerprint` is the only constructor of `SourceFingerprint`, " +
      "derived from the stored envelope and every object stored beside it, so " +
      "`rawHash` changes whenever a stored byte does. The " +
      "`raw-hash-from-source-fingerprint` rule rejects a hand-written `rawHash` " +
      "in adapters, and `scripts/source-fingerprint-baseline.ts` enumerates " +
      "every registered source, every exempt file and every external-id writer " +
      "against a shrink-only baseline.",
    enforcement: { kind: "none" },
  },
  {
    id: "bulk-row-insert",
    capability:
      "Inserting an unbounded row set whose inserted rows are not read back",
    owner: ["apps/api/src/lib/db/bulk-write.ts"],
    summary:
      "`insertInChunks` owns the batch size that keeps a multi-row insert under " +
      "PostgreSQL's 65,535 bind-parameter cap, and owns the one chunking loop " +
      "the codebase exempts from `scripts/db-await-in-loop.ts`. A caller that writes " +
      "its own loop pays a round trip per row or re-derives the cap per table; " +
      "callers pass the writer, so `values()` stays where the table is known and " +
      "drizzle's row inference is untouched. Scoped to writes whose result is " +
      "discarded: `lib/notifications.ts` chunks its own fan-out because it needs " +
      "the inserted rows back to decide which recipient streams to ping, and " +
      "sizes batches for a different reason (one announcement to a large firm). " +
      "Folding it in means teaching this owner to return rows; until then the " +
      "two are different capabilities rather than a bypassed one.",
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
    id: "stored-file-read",
    capability: "Reading stored file bytes",
    owner: ["apps/api/src/lib/file-scan/stored-file.ts"],
    summary:
      "`readStoredFile` owns stored file reads for request delivery. Named " +
      "processing, maintenance, and transport-test consumers use the raw " +
      "readers for their specific operations.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/s3"],
      names: [
        "getS3ObjectWithSignal",
        "readS3ObjectIfPresent",
        "readS3ObjectBounded",
        "readS3ObjectBoundedIfPresent",
        "readS3ArrayBuffer",
      ],
      allowed: [
        {
          path: "apps/api/src/handlers/case-law/ingestion/pipeline/stored-raw.ts",
          reason: "Loads persisted source bytes for ingestion.",
        },
        {
          path: "apps/api/src/handlers/case-law/ingestion/eu-completion-runner.ts",
          reason:
            "Loads persisted source bytes under the completion job's byte cap and tick deadline.",
        },
        {
          path: "apps/api/src/handlers/case-law/ingestion/background-replay-runner.ts",
          reason:
            "Loads persisted source bytes under the replay tick's byte cap and deadline.",
        },
        {
          path: "apps/api/src/handlers/chat/chat-prompt.ts",
          reason: "Loads document bytes for prompt preparation.",
        },
        {
          path: "apps/api/src/handlers/files/document-properties.ts",
          reason: "Reads office bytes to extract document properties.",
        },
        {
          path: "apps/api/src/handlers/files/update-document-properties.ts",
          reason: "Reads office bytes before updating document properties.",
        },
        {
          path: "apps/api/src/handlers/entities/publish-folio-collab-version.ts",
          reason:
            "Reads a collaboration checkpoint before publishing a document version.",
        },
        {
          path: "apps/api/src/handlers/entities/checkpoint-folio-collab-room.ts",
          reason:
            "Reads a collaboration snapshot before storing its checkpoint.",
        },
        {
          path: "apps/api/src/handlers/entities/finalize-desktop-edit-session.ts",
          reason:
            "Reads an edit checkpoint before finalizing the document version.",
        },
        {
          path: "apps/api/src/handlers/reports/builtin-templates.ts",
          reason: "Loads stored templates for report rendering.",
        },
        {
          path: "apps/api/src/handlers/uploads/update.ts",
          reason: "Reads the staged upload for processing and verification.",
        },
        {
          path: "apps/api/src/mcp/file-comparison-run.ts",
          reason: "Loads comparison inputs for document processing.",
        },
        {
          path: "apps/api/src/scripts/replay-case-law-source.ts",
          reason: "Loads persisted source bytes for replay.",
        },
        {
          path: "apps/api/src/scripts/case-law-source-backfill.ts",
          reason: "Loads persisted source bytes for backfill.",
        },
        {
          path: "apps/api/scripts/backfill-image-thumbnails.ts",
          reason: "Loads stored image bytes to build missing thumbnails.",
        },
        {
          path: "apps/api/src/lib/folio-collab-rooms.ts",
          reason: "Loads the persisted collaboration room snapshot.",
        },
        {
          path: "apps/api/src/lib/lists/verification/document-text.ts",
          reason: "Extracts stored document text for list verification.",
        },
        {
          path: "apps/api/src/lib/health/readiness.ts",
          reason:
            "Reads the dedicated readiness object to check storage connectivity.",
        },
        {
          path: "apps/api/src/lib/legal-search/raw-source-storage.ts",
          reason: "Loads persisted legal source bytes for processing.",
        },
        {
          path: "apps/api/src/lib/legal-search/case-law-raw-layout.ts",
          reason: "Loads source layout bytes for case-law processing.",
        },
        {
          path: "apps/api/src/lib/workflow/generate-batch.ts",
          reason: "Loads workflow document inputs for generation.",
        },
        {
          path: "apps/api/src/lib/file-scan/stored-object.ts",
          reason: "Loads bounded object bytes for scanning.",
        },
        {
          path: "apps/api/src/lib/file-derivative-queue.ts",
          reason: "Loads source bytes for derivative generation.",
        },
        {
          path: "apps/api/src/lib/files/organization-file-usage.ts",
          reason: "Verifies stored object bytes during usage reconciliation.",
        },
        {
          path: "apps/api/src/lib/bbox/generate-b-boxes-shared.ts",
          reason: "Loads source bytes for bounding-box generation.",
        },
        {
          path: "apps/api/src/lib/files/office-evidence.ts",
          reason: "Loads office bytes to extract stored file evidence.",
        },
        {
          path: "apps/api/src/lib/s3.test.ts",
          reason: "Exercises the object-read transport.",
        },
        {
          path: "apps/api/src/tests/helpers/fake-s3.test.ts",
          reason: "Exercises the stored-object test adapter.",
        },
      ],
    },
  },
  {
    id: "stored-tenant-file-read",
    capability: "Reading tenant-scoped stored file bytes",
    owner: ["apps/api/src/lib/file-scan/stored-file.ts"],
    summary:
      "`readStoredFile` owns stored file reads for request delivery. Named " +
      "processing, maintenance, and transport-test consumers use the raw " +
      "readers for their specific operations.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/s3-presign"],
      names: ["readTenantS3ArrayBuffer"],
      allowed: [
        {
          path: "apps/api/src/handlers/contacts/extract-procuracao.ts",
          reason: "Loads an authorized document for contact extraction.",
        },
        {
          path: "apps/api/src/lib/document-processing-queue.ts",
          reason: "Loads tenant-scoped source bytes for document processing.",
        },
        {
          path: "apps/api/src/lib/ocr-local/recognize-local.ts",
          reason: "Loads tenant-scoped source bytes for local recognition.",
        },
        {
          path: "apps/api/src/lib/s3-presign.test.ts",
          reason: "Exercises tenant-scoped object reads.",
        },
      ],
    },
  },
  {
    id: "audited-download-grant",
    capability: "Granting a user a signed URL to stored file content",
    owner: ["apps/api/src/lib/audited-download.ts"],
    summary:
      "A signed URL hands the caller the stored bytes, whether the browser " +
      "saves them or renders them inline. `auditedPresignDownload` records a " +
      "download or an access in the caller's transaction before it signs, so a grant " +
      "and its audit row commit together. The bare signer stays with modules " +
      "that sign an object whose access an audited operation already recorded.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/s3-presign"],
      names: ["presignDownloadUrl"],
      allowed: [
        {
          path: "apps/api/src/handlers/reports/exports/get.ts",
          reason:
            "Signs the result of the requester's own report export, audited when the export runs.",
        },
        {
          path: "apps/api/src/lib/entity-versions/desktop-edit-session-utils.ts",
          reason:
            "Signs the working copy of a desktop edit session or collaboration room, audited when it opens.",
        },
        {
          path: "apps/api/src/lib/uploads/file-comparison/deliver-redline.ts",
          reason:
            "Signs a temporary redline produced by an audited comparison run.",
        },
      ],
    },
  },
  {
    id: "content-delivery-intent",
    capability: "Recording stored-content delivery intent",
    owner: ["apps/api/src/lib/files/content-delivery.ts"],
    summary:
      "The handler invocation owns the delivery scope; response and audit " +
      "owners record their corresponding events through named entry points.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/files/content-delivery"],
      names: ["markContentDeliveryIntent"],
      allowed: [
        {
          path: "apps/api/src/lib/api-handlers.ts",
          reason:
            "Records intent for file bodies and disposition headers at the response boundary.",
        },
        {
          path: "apps/api/src/lib/secure-document-response.ts",
          reason: "Records intent when constructing a stored-content response.",
        },
        {
          path: "apps/api/src/lib/s3-presign.ts",
          reason: "Records intent when granting a stored-content URL.",
        },
      ],
    },
  },
  {
    id: "content-delivery-receipt",
    capability: "Recording a content-delivery audit receipt",
    owner: ["apps/api/src/lib/files/content-delivery.ts"],
    summary:
      "The handler invocation owns the delivery scope; response and audit " +
      "owners record their corresponding events through named entry points.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/files/content-delivery"],
      names: ["recordContentDeliveryReceipt"],
      allowed: [
        {
          path: "apps/api/src/lib/audited-download.ts",
          reason: "Records a receipt after the content-grant audit write.",
        },
        {
          path: "apps/api/src/lib/audit-log.ts",
          reason: "Records a receipt after a content-access audit write.",
        },
        {
          path: "apps/api/src/tests/helpers/audit-recorder-double.ts",
          reason:
            "The handler-test audit recorder double issues the receipt the production recorder issues for an access event.",
        },
      ],
    },
  },
  {
    id: "content-delivery-scope",
    capability: "Running and checking the content-delivery scope",
    owner: ["apps/api/src/lib/files/content-delivery.ts"],
    summary:
      "The handler invocation owns the delivery scope; response and audit " +
      "owners record their corresponding events through named entry points.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/files/content-delivery"],
      names: ["runWithContentDeliveryScope", "getContentDeliveryReceiptError"],
      allowed: [
        {
          path: "apps/api/src/lib/api-handlers.ts",
          reason: "Runs and checks the scope around the handler invocation.",
        },
      ],
    },
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
    id: "typed-decisions",
    capability:
      "Typed decisions: a choice from a closed set, a yes/no or a score, asked of a decision model",
    owner: [
      "apps/api/src/lib/workflow/decisions/decide.ts",
      "apps/api/src/lib/workflow/decisions/decision-model.ts",
      "apps/api/src/lib/workflow/decisions/system-one.ts",
      "apps/api/src/lib/workflow/decisions/system-one-runtime.ts",
      "apps/api/src/lib/workflow/decisions/answer-questions.ts",
    ],
    summary:
      "A decision model answers typed questions about a state with probability " +
      "distributions; it generates nothing. `decide.ts` is the one entry: it " +
      "resolves the organization's model (or the instance's, or none), applies " +
      "the confidence floor, captures failures and logs every decision, and " +
      "returns a `Decision` the caller must narrow before reading, so a " +
      "deployment without a model takes the same path as an answer under the " +
      "floor. `decision-model.ts` owns which model answers for an org, " +
      "`system-one.ts` the wire contract and retry, `system-one-runtime.ts` the " +
      "instance credential, and `answer-questions.ts` the translation of a table " +
      "column (select, date, int) into questions and back into the `Answer` the " +
      "generative path writes. A caller builds questions with the constructors in " +
      "`system-one.ts` and asks them through `decide`; it never holds a client.",
    enforcement: {
      kind: "import",
      specifiers: [
        "@/api/lib/workflow/decisions/system-one-runtime",
        "@/api/lib/workflow/decisions/system-one",
      ],
      names: ["getSystemOneClient", "createSystemOneClient"],
      allowed: [
        {
          path: "apps/api/src/scripts/polarity-system-one-compare.ts",
          reason:
            "Measures the raw model against the corpus with a pinned client; the floor is what it calibrates, so it reads below `decide`.",
        },
      ],
    },
  },
  {
    id: "member-authority-context",
    capability: "Building the authority a request context carries",
    owner: ["apps/api/src/lib/permission-authorization.ts"],
    summary:
      "Context builders construct opaque member authority once; handlers spend it through the permission owner.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/permission-authorization"],
      names: ["sessionMemberRole", "authorizedMemberRole"],
      allowed: [
        {
          path: "apps/api/src/lib/machine-api-keys/personal-lifecycle.ts",
          reason:
            "Builds the key owner authority from a locked live membership before minting.",
        },
        {
          path: "apps/api/src/lib/auth.ts",
          reason: "Builds the authenticated session context.",
        },
        {
          path: "apps/api/src/mcp/effective-authority.ts",
          reason: "Builds authority for the MCP request context.",
        },
        {
          path: "apps/api/src/mcp/api-key-auth.ts",
          reason:
            "Validates a credential's grants against its current membership.",
        },
        {
          path: "apps/api/src/lib/business-registries/desktop/auth.ts",
          reason: "Builds the authenticated desktop account context.",
        },
        {
          path: "apps/api/src/lib/business-registries/desktop/link-grants.ts",
          reason: "Builds the linked desktop account context.",
        },
        {
          path: "apps/api/scripts/ai-provider-canary-chat-toolsets.ts",
          reason:
            "Builds an owner session to assemble the full chat tool set for provider schema checks; serves no request.",
        },
      ],
    },
  },
  {
    id: "current-member-permission",
    capability:
      "Revalidating a persisted membership during an authorized operation",
    owner: ["apps/api/src/lib/permission-authorization.ts"],
    summary:
      "The request spends its credential at the handler boundary; a locked membership is revalidated by the permission owner.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/permission-authorization"],
      names: ["hasCurrentMemberPermission"],
      allowed: [
        {
          path: "apps/api/src/lib/business-registries/desktop/renewal.ts",
          reason:
            "Revalidates the locked membership after desktop credential authorization.",
        },
        {
          path: "apps/api/src/lib/workspace-deletion.ts",
          reason:
            "Revalidates the actor's locked membership after the handler authorizes deletion.",
        },
      ],
    },
  },
  {
    id: "member-authorization",
    capability: "Deciding what a request's member role and credential may do",
    owner: [
      "apps/api/src/lib/permission-authorization.ts",
      "apps/web/src/lib/organization/role-assignment.logic.ts",
    ],
    summary:
      "Every permission decision reads the request's `AuthorizedMemberRole`: " +
      "the member role together with the credential behind the request. A " +
      "person's session spends the role; a credential minted with a narrower " +
      "permission set spends only what both grant. `hasMemberPermission` and " +
      "`hasManagementPermission` are the reads, and every handler context " +
      "builder sets the credential once, so no handler-level check can fall " +
      "back to the role's full authority. Reading the role table directly " +
      "skips the credential. The web organization role-policy owner derives " +
      "session UI visibility and assignable roles from the shared role policy; " +
      "API decisions still enforce the request credential.",
    enforcement: {
      kind: "import",
      specifiers: ["@stll/permissions"],
      names: ["roles", "isOrganizationManagementRole"],
      allowed: [
        {
          path: "apps/api/src/lib/member-roles.ts",
          reason:
            "Recognizes the role names the table defines; it decides no permission.",
        },
        {
          path: "apps/api/src/lib/auth.ts",
          reason:
            "Configures the authentication library's organization roles from the same table.",
        },
        {
          path: "apps/web/src/lib/auth-client.ts",
          reason:
            "Configures the web authentication client's organization roles from the same table.",
        },
        {
          path: "packages/scripts/src/agent-session.ts",
          reason:
            "Local development tooling seeds an owner's key with the owner's full statement set.",
        },
        {
          path: "apps/api/src/mcp/billing-tools.ts",
          reason:
            "`isVisibleToMemberRole` decides which tools are listed; each tool checks the request's effective authority when called.",
        },
        {
          path: "apps/api/src/handlers/entities/join-folio-collab-room.ts",
          reason:
            "Re-checks the person's current membership role, read from the database, when a room is joined.",
        },
        {
          path: "apps/api/src/lib/folio-collab-rooms.ts",
          reason:
            "Re-checks the person's current membership role, read from the database, when a room token is used.",
        },
        {
          path: "apps/api/src/lib/entities/workspace-entity-write-access.ts",
          reason:
            "Re-checks the person's current membership role, read from the database, when a desktop or signing session is used.",
        },
      ],
    },
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
        {
          path: "apps/api/src/lib/file-scan/document-parsers.ts",
          reason:
            "Parse boundary: wraps applyFolioAIEditsToBuffer so its input must be a ScannedFile; applyAiEditsToDocx in the owner calls the wrapper, so edit attribution stays with the owner.",
        },
      ],
    },
  },
  {
    id: "model-run-failure-projection",
    capability: "Running a model through the engine's raw run forms",
    owner: ["apps/api/src/lib/tanstack-ai-generate.ts"],
    summary:
      "A failed run's `RUN_ERROR` message and code, and the errors the engine " +
      "throws, carry provider bodies and model output. The owner turns every " +
      "failure into a `ProviderCallError` or `ModelRunError` with a fixed " +
      "message (`withRecoveredProviderStatus`), and hands a caller that " +
      "consumes chunks itself `streamTanStackChatRun`, whose `RUN_ERROR` " +
      "carries only that message and the classified kind. A caller that " +
      "assembles its own options uses `streamTanStackChatRun`, " +
      "`collectTanStackTextRun` or `generateTanStackChatObject`.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/chat/tanstack-chat-runtime"],
      names: RAW_MODEL_RUN_NAMES,
      allowed: [
        {
          path: "apps/api/src/handlers/chat/stream-chat.ts",
          reason:
            "The chat turn projects each `RUN_ERROR` through `normalizeRunErrorChunk` before it is streamed or stored.",
        },
        {
          path: "apps/api/evals/",
          reason:
            "Offline evaluations: a run failure is reported to the operator and never stored.",
        },
        {
          path: "apps/api/scripts/ai-provider-canary.ts",
          reason:
            "Provider canary: reads the raw run error to report the provider's answer to the operator.",
        },
        {
          path: "apps/api/scripts/benchmark-chat-read-surface.ts",
          reason: "Benchmark with synthetic content; nothing is stored.",
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
    id: "chat-stream-processor",
    capability: "Accumulating a TanStack stream into the message it produced",
    owner: ["apps/api/src/lib/chat/stream-message-capture.ts"],
    summary:
      "A chat turn's persisted message is folded from its stream by a " +
      "`StreamProcessor` inside `processTurnForPersistence`. A second " +
      "construction with its own event wiring could accumulate something other " +
      "than what production stores, so `createStreamMessageCapture` is the one " +
      "constructor and callers only choose what to keep from the finished message.",
    enforcement: {
      kind: "import",
      specifiers: ["@tanstack/ai"],
      names: ["StreamProcessor"],
      allowed: [],
    },
  },
  {
    id: "chat-ref-registry",
    capability: "Creating chat ref registries for a turn or saved transcript",
    owner: ["apps/api/src/handlers/chat/send-message.ts"],
    summary:
      "A ref such as `ent_1` keeps its target within its chat thread. " +
      "The send owns minting new refs; readers of saved transcripts rebuild " +
      "the registry from persisted bindings to resolve or neutralize those " +
      "refs. Other code returns ids and resolved links instead.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/chat/ref-registry"],
      names: ["createChatRefRegistry"],
      allowed: [
        {
          path: "apps/api/scripts/ai-provider-canary-chat-toolsets.ts",
          reason:
            "Builds one chat request's toolsets offline to project their schemas for each provider; the registry never leaves that build.",
        },
        {
          path: "apps/api/src/handlers/chat/tools/chat-history-tools.ts",
          reason:
            "Rebuilds persisted bindings when expanding saved messages so refs from another turn are rebound or neutralized.",
        },
        {
          path: "apps/api/src/handlers/chat/skill-availability/offered-tools.ts",
          reason:
            "Builds a new chat's tool set only to read its tool names for skill availability; no tool runs and the registry never leaves that build.",
        },
        {
          path: "apps/api/src/lib/scheduler/tasks/memory-extractor.ts",
          reason:
            "Rebuilds persisted bindings to turn saved transcript refs into durable links before storing memories.",
        },
        {
          path: "apps/api/evals/playbook-authoring.ts",
          reason:
            "Replays each scripted chat request against the live tools and mints that request's registry, as send-message does; refs never outlive the replayed request.",
        },
      ],
    },
  },
  {
    id: "chat-composer-status-row",
    capability: "Chat composer status-row assembly and loading state",
    owner: ["apps/web/src/components/chat/chat-composer-dock.tsx"],
    summary:
      "ChatComposerDock owns the pending/ready discriminator and the canonical " +
      "control order, so loading keeps every known icon and fixed dimension " +
      "while only unresolved values render a skeleton.",
    enforcement: {
      kind: "import",
      specifiers: ["@stll/ui/composer"],
      names: ["ComposerStatusRow"],
      allowed: [
        {
          path: "apps/web/src/routes/law/-law-home/law-entry-box.tsx",
          reason:
            "The public-law entry box has its own non-chat jurisdiction and scope row.",
        },
      ],
    },
  },
  {
    id: "chat-composer-status-controls",
    capability: "Chat composer web-search, anonymization, and context controls",
    owner: ["apps/web/src/components/chat/chat-composer-dock.tsx"],
    summary:
      "The dock is the only assembler of the known globe, shield, and context " +
      "controls. Its typed pending branch disables those real controls instead " +
      "of substituting lookalike skeleton blocks.",
    enforcement: {
      kind: "import",
      specifiers: [
        "@/components/chat/chat-context-meter",
        "@/features/chat/components/chat-anonymized-toggle",
        "@/features/chat/components/chat-web-search-toggle",
      ],
      names: [
        "ChatAnonymizedToggle",
        "ChatContextMeter",
        "ChatWebSearchToggle",
      ],
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
    id: "template-version-publication",
    capability: "Publishing stored template DOCX revisions and version history",
    owner: [
      "apps/api/src/lib/templates/write-template.ts",
      "apps/api/src/lib/templates/create-template.ts",
    ],
    summary:
      "Existing-template writes prepare and upload outside transactions, then " +
      "publish against the exact snapshot with durable cleanup ownership and " +
      "transactional audit. Initial creation has its own owner. " +
      "`no-direct-template-version-write` confines version-row mutations to these owners.",
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
    id: "file-encryption",
    capability: "Deciding a stored file's `encrypted` attribute",
    owner: ["apps/api/src/lib/files/detect-file-encryption.ts"],
    summary:
      "Every file content writer takes a `FileEncryption`, which only this " +
      "module makes: from the bytes (PDFs go through the PDF worker), from an " +
      "Office editor's output, from bytes the server built, or from a stored " +
      "copy. The PDF probe is confined here, `no-literal-derived-attribute` " +
      "rejects a literal written to `encrypted` elsewhere in the API, and " +
      "`file-encryption-writers.test.ts` enumerates the writers.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/files/pdf-utils"],
      names: ["isEncryptedPdf"],
      allowed: [],
    },
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
    id: "invoice-document",
    capability:
      "Invoice, advance, and credit note totals and Czech payment payloads",
    owner: ["packages/invoicing/"],
    summary:
      "The package rounds VAT per line, sums document and rate totals in " +
      "branded minor units, and returns SPAYD text for payable documents. " +
      "QR matrix rendering remains with callers.",
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
    id: "text-mark",
    capability:
      "Marking words in running text: search and find hits, reader highlights, verdict underlines",
    owner: ["packages/ui/src/review/text-mark.tsx"],
    summary:
      "One inline mark with a fill or a line, a tone and an active state, so a " +
      "found word, a note and a finding differ only in hue and line. Render " +
      "`TextMark`, or take `textMarkClass` for markup that is not a `<mark>`; " +
      "search hits use `SEARCH_HIT_MARK`. The `no-ad-hoc-text-mark` lint rule " +
      "rejects a hand-styled `<mark>`.",
    enforcement: { kind: "none" },
  },
  {
    id: "charset-misdecoding",
    capability:
      "Detecting and undoing text decoded with the wrong character set",
    owner: ["packages/mojibake/"],
    summary:
      "Ingestion guards and corpus checks judge a text against its declared " +
      "language's CLDR exemplar letters, which covers every language CLDR " +
      "does and needs no reader of the language. A check that lists letters " +
      "or byte pairs for one language is a second, narrower detector; extend " +
      "this one.",
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
    capability:
      "Temporal runtime, calendar-date arithmetic, ISO date-only parsing, durations",
    owner: ["packages/time/"],
    summary:
      "`@stll/time` exports the side-effect-free `temporal-polyfill/full` " +
      "ponyfill, which selects native Temporal when available. Runnable apps " +
      "and private workspace packages import it from this owner; published " +
      "packages declare and import the ponyfill directly. Runtime entrypoints never " +
      "install an ambient global. A calendar day is not 24 hours across a " +
      "DST transition, so moving to another date uses Temporal calendar " +
      "arithmetic. Elapsed-time math uses the duration constants. The date " +
      "lint rules route callers here and reserve legacy `Date` for named " +
      "library boundaries. See [Temporal conventions](temporal.md).",
    enforcement: { kind: "none" },
  },
  {
    id: "runtime-mode",
    capability:
      "Server runtime mode: strict, or open to local development capabilities",
    owner: ["packages/runtime-mode/"],
    summary:
      "`@stll/runtime-mode` is the one reader of `NODE_ENV` and " +
      "`STELLA_LOCAL_DEV`. A process is open only with a local `NODE_ENV`, " +
      "`STELLA_LOCAL_DEV=1` and a build that is not a release; an opt-in it " +
      "cannot honour fails startup. Each app resolves the mode once (the API " +
      "in `apps/api/src/runtime-mode.ts`) and every local development " +
      "capability checks it. The `runtime-mode-keys` lint rule keeps the two " +
      "keys inside this owner.",
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
  {
    id: "database-load-gate",
    capability: "Gating and sizing heavy database maintenance",
    owner: [
      "packages/db-load-gate/",
      "apps/api/src/lib/db/ebs-balance-reader.ts",
    ],
    summary:
      "One transport-free package combines health signals, records decisions, " +
      "sizes batches and arbitrates a database-wide priority slot. The API " +
      "adapter alone reads both RDS EBS balances through CloudWatch; index " +
      "runners and backfills use the same source and freshness rules.",
    enforcement: { kind: "none" },
  },
  {
    id: "bounded-concurrency",
    capability:
      "Running an async operation over a list with a bounded number in flight",
    owner: ["packages/concurrency/"],
    summary:
      "A windowed `Promise.all` over slices is the shape everyone reaches for " +
      "and it is not a concurrency bound: the window refills only once its " +
      "slowest member settles, so effective concurrency decays to each slice's " +
      "tail and drops to zero for whatever the caller does between slices. " +
      "`mapWithConcurrency` returns every result and keeps the pool full " +
      "throughout. `streamWithConcurrency` yields each result in input order " +
      "as it is ready, and its `lookAhead` decides whether the pool refills " +
      "on completion or on consumption: at the default of zero a settled " +
      "result holds its slot, so the pool slides and residency stays at " +
      "`limit`; a caller that wants work to continue through a slow item and " +
      "through its own per-result work has to ask for look-ahead and pay for " +
      "up to `limit + lookAhead` resident results. The stream observes each " +
      "settlement at the pool, so a rejection behind a slower item cannot " +
      "surface as an unhandled rejection, and nothing it started outlives " +
      "its consumer: closing the stream starts nothing more and waits for " +
      "what is already running.",
    enforcement: { kind: "none" },
  },
  {
    id: "case-law-adapter-manifest",
    capability: "Case-law source declarations",
    owner: [
      "apps/api/src/lib/legal-search/adapter-manifest.ts",
      "apps/api/src/lib/case-law/ecli-court-codes.ts",
    ],
    summary:
      "One total map binds every adapter key to its source name, jurisdiction, " +
      "known ECLI court codes, declared text sentinels, and date range. " +
      "Each jurisdiction selection also carries its declared docket grammar. " +
      "Adapters read the declaration, and the runner " +
      "reads the resulting total registry, so adding a source requires one " +
      "complete entry.",
    enforcement: { kind: "none" },
  },
  {
    id: "case-law-docket-grammar",
    capability: "Parsing and comparing decision docket identifiers",
    owner: [
      "packages/api-contract/src/decision-docket-grammar.ts",
      "packages/api-contract/src/decision-query-intent.ts",
    ],
    summary:
      "One total jurisdiction map recognizes docket syntax and returns normalized display and comparison forms. " +
      "Search intent classification and exact result matching use that same parser, so a spelling cannot be classified under one rule and compared under another.",
    enforcement: { kind: "none" },
  },
  {
    id: "case-law-launch-readiness",
    capability: "Selecting countries exposed by public case-law surfaces",
    owner: [
      "packages/api-contract/src/case-law-launch-readiness.ts",
      "packages/api-contract/src/launch-readiness.json",
      "apps/web/src/lib/case-law-route.ts",
    ],
    summary:
      "One checked-in inclusion list carries complete readiness evidence for each public country. " +
      "The shared parser rejects incomplete or ambiguous rows, and web and API consumers use the resulting country boundary.",
    enforcement: { kind: "none" },
  },
  {
    id: "legislation-canonical-source",
    capability:
      "Choosing where a legislation version's canonical AST or text is read from",
    owner: ["apps/api/src/lib/legal-search/legislation-canonical-source.ts"],
    summary:
      "The storage mode and the row's object key decide between object storage " +
      "and the Postgres copy. Readers and projections ask " +
      "`canonicalLegislationAstSource` or `canonicalLegislationTextSource`; " +
      "`legislation-canonical-source.test.ts` fails when a new file reads a " +
      "version's AST columns directly.",
    enforcement: { kind: "none" },
  },
  {
    id: "public-country-unavailable-answer",
    capability:
      "Answering an advertised public-law country that holds no public corpus",
    owner: ["apps/api/src/lib/legal-search/public-law-country.ts"],
    summary:
      "The refusal is an answered client outcome at the contract's " +
      "`PUBLIC_COUNTRY_UNAVAILABLE_STATUS`, never a server fault. HTTP handlers " +
      "receive it only as the owner's built answer (`readPublicLawCountry`, " +
      "`publicLawCountryUnavailable`) and declare it with " +
      "`withPublicCountryUnavailable`, so no handler holds a bare body to send " +
      "under another status.",
    enforcement: {
      kind: "import",
      specifiers: ["@stll/api-contract/public-country-capability"],
      names: ["publicCountryUnavailable"],
      allowed: [
        {
          path: "apps/api/src/mcp/stella-tools.ts",
          reason:
            "MCP tools return the typed body as tool data; no HTTP status is involved.",
        },
        {
          path: "apps/api/src/mcp/legislation-tools.ts",
          reason:
            "MCP tools return the typed body as tool data; no HTTP status is involved.",
        },
      ],
    },
  },
  {
    id: "legislation-publication",
    capability: "Selecting jurisdictions admitted to public statute reads",
    owner: [
      "packages/api-contract/src/legislation-publication.ts",
      "apps/api/src/lib/legal-search/legislation-redistribution.ts",
    ],
    summary:
      "Statute jurisdiction admission is independent of case-law corpus readiness. " +
      "Collection, identifier, version, snippet and sitemap reads combine that admission with source redistribution permission.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/legal-search/legislation-redistribution"],
      names: ["redistributableLegislationSource"],
      allowed: [
        {
          path: "apps/api/src/handlers/legislation/non-redistributable-sources.ts",
          reason:
            "The source inventory describes redistribution restrictions independently of publication admission.",
        },
        {
          path: "apps/api/src/handlers/legislation/search-index.ts",
          reason:
            "Background indexing retains the broader corpus; public search applies admission when querying and hydrating hits.",
        },
        {
          path: "apps/api/src/handlers/legislation/search.ts",
          reason:
            "The PostgreSQL search projection aliases its country column and pairs source permission with publishedLegislationCountryFor.",
        },
      ],
    },
  },
  {
    id: "case-law-decision-text",
    capability:
      "Representing publisher-authored decision text at ingestion and public read boundaries",
    owner: [
      "packages/api-contract/src/case-law-text-field.ts",
      "apps/api/src/lib/case-law/decision-headnote.ts",
      "apps/api/src/lib/case-law/decision-headnote-schema.ts",
      "apps/api/src/lib/case-law/decision-text.ts",
      "apps/api/src/lib/case-law/decision-text-sql.ts",
    ],
    summary:
      "The shared discriminated values make text presence and row-preview truncation explicit to API consumers. " +
      "The API owner classifies source values, converts them to storage metadata, " +
      "and reconstructs bounded public values; the adapter lint keeps protected keys behind that boundary.",
    enforcement: { kind: "none" },
  },
  {
    id: "case-law-plain-text",
    capability:
      "Sanitizing publisher labels and metadata into branded plain text",
    owner: [
      "apps/api/src/lib/case-law/plain-text.ts",
      "apps/api/src/lib/legal-search/plain-text-assembly.ts",
      "apps/api/src/lib/case-law/plain-text-markup.ts",
    ],
    summary:
      "The shared sanitizer owns the private PlainText brand, markup removal, " +
      "and structural whitespace normalization. Adapters pass publisher text " +
      "through this boundary; no-forged-plain-text rejects casts, type predicates, " +
      "and parallel brand declarations outside the owner. The markup module " +
      "shares the language-blind output predicate used by ingestion guards.",
    enforcement: { kind: "none" },
  },
  {
    id: "search-total",
    capability: "Declaring whether a search result total was counted",
    owner: [
      "packages/api-contract/src/search.ts",
      "apps/api/src/lib/search/total-schema.ts",
    ],
    summary:
      "One discriminated contract distinguishes an exact count, an estimate, " +
      "and a search that did not compute a count. The API schema enforces the " +
      "same closed branches at response boundaries, so consumers never infer " +
      "count semantics from null or from the search implementation.",
    enforcement: { kind: "none" },
  },
  {
    id: "agent-input-normalization",
    capability:
      "Reading a value a model wrote on the MCP/CLI wire: dates, date formats, numbers, booleans, locales, countries, closed vocabularies",
    owner: ["packages/agent-input/src/"],
    summary:
      "Every agent-facing surface is lenient in the same way or it is lenient " +
      "in several different ways, which is worse than being strict: `4 000`, " +
      "`1. 10. 2026`, `ano` and `cs_CZ` have to mean the same thing in a " +
      "marker, in a tool input and in a fill value. One reader per kind " +
      "auto-normalizes the spellings that carry a single meaning and returns " +
      "the one ask-for-a-fix shape (`received`, `expected`, `hint`) when a " +
      "spelling carries two — `01/02/2026` and a bare `1,234` are asked " +
      "about, never guessed, because guessing them wrong is a wrong date or " +
      "a factor of a thousand on an instrument. The rule below confines " +
      "locale plausibility, whose canonical spelling is also what keeps " +
      "`new Intl.DateTimeFormat` from throwing at fill time; the other kinds " +
      "are held by the census in `agent-input-owner.test.ts`, which lists the " +
      "pre-existing readers of our own bytes that are not agent input.",
    enforcement: {
      kind: "global-member",
      object: "Intl",
      path: ["getCanonicalLocales"],
      allowed: [],
    },
  },
  {
    id: "country-spelling",
    capability:
      "Resolving a country a caller spelled its own way to its canonical ISO code",
    owner: ["packages/agent-input/src/"],
    summary:
      "A country decides which body of law a call searches, so reading one " +
      "wrong is a wrong answer rather than a formatting defect. One reader " +
      "maps every spelling that carries a single meaning — alpha-3, alpha-2, " +
      "and the country's CLDR name in each language the corpus serves — onto " +
      "one canonical code, and asks with both readings named when a spelling " +
      "carries two. The alpha-3 half of ISO 3166-1 is what a second reader " +
      "would need, so the rule below confines it: `COUNTRY_CODES` and " +
      "`isCountryCode` stay open for the surfaces that hold an alpha-2 " +
      "column, while the alpha-3 table and its lookups reach only the owner. " +
      "Two lenient readers of one kind are worse than one strict reader, " +
      "because they disagree about which country a name names.",
    enforcement: {
      kind: "import",
      // Both spellings of one module: the package entry point, and the file
      // that defines the table as a repository path. Relative imports resolve
      // to that path, so `@stll/country-codes` alone would leave a deep
      // relative import of the source file unconfined.
      specifiers: [
        "@stll/country-codes",
        "packages/country-codes/src/alpha3.ts",
      ],
      names: [
        "COUNTRY_ALPHA3_BY_CODE",
        "COUNTRY_ALPHA3_CODES",
        "countryCodeFromAlpha3",
        "isCountryAlpha3Code",
      ],
      allowed: [
        {
          path: "packages/country-codes/src/index.ts",
          reason:
            "The package entry point re-exports the table it defines; readers stay confined at the package specifier.",
        },
      ],
    },
  },
  {
    id: "mcp-output-contracts",
    capability:
      "Binding first-party MCP handler results to structured content and advertised output schemas",
    owner: [
      "apps/api/src/mcp/tool-types.ts",
      "apps/api/src/mcp/tool-utils.ts",
      "apps/api/src/mcp/valibot-tool-definition.ts",
      "apps/api/src/mcp/static-tool-definitions.ts",
      "apps/api/src/mcp/gateway/dynamic-tool-policy.ts",
      "apps/api/src/mcp/gateway/list-tools.ts",
      "apps/api/src/mcp/tools.ts",
    ],
    summary:
      "Each static tool set supplies one Valibot output contract per handler, " +
      "and each Stella-owned dynamic tool family (skills) one shared contract " +
      "in its family policy. The shared factory derives the JSON Schema shown " +
      "in tools/list, the tool-set type binds it to the handler result, and " +
      "dispatch validates the post-egress projection before serving " +
      "structuredContent. Third-party connector tools keep their upstream " +
      "contract and are relayed as text. Explicit projectors keep dynamic " +
      "results compact without changing legacy text output.",
    enforcement: { kind: "none" },
  },
  {
    id: "bullmq-worker",
    capability:
      "Constructing BullMQ workers with a shared failure record policy",
    owner: ["apps/api/src/lib/bullmq-queue.ts"],
    summary:
      "BullMqWorker owns persisted job failure records while retaining original errors in worker events. All queue workers use this constructor.",
    enforcement: {
      kind: "import",
      specifiers: ["bullmq"],
      names: ["Worker"],
      allowed: [],
    },
  },
  {
    id: "deterministic-job-requeue",
    capability:
      "Re-enqueueing a row's work under its deterministic BullMQ job id",
    owner: ["apps/api/src/lib/bullmq-requeue.ts"],
    summary:
      "A queue ignores an `add` whose id it still holds, and retention keeps " +
      "terminal records after the row they ran for is reopened, so every " +
      "enqueue under a reused id reads the job's state first. " +
      "`requeueDeterministicJob` maps each state BullMQ reports to one action " +
      "from a total table (live states are owned, a failed job is retried " +
      "with a fresh attempt budget, a completed one is replaced) and bounds " +
      "every queue command, so the enqueue paths and the reconcilers that " +
      "repeat them cannot drift apart.",
    enforcement: {
      kind: "member-call",
      method: "getState",
      within: ["apps/api/src/"],
      allowed: [
        {
          path: "apps/api/src/lib/report-export-recovery.ts",
          reason:
            "Reads a job's state to decide whether an export outlived its job; it never enqueues.",
        },
      ],
    },
  },
  {
    id: "corpus-hit-classification",
    capability: "Classifying corpus engine hit identities",
    owner: ["apps/api/src/lib/legal-search/corpus-hit-disposition.ts"],
    summary:
      "The identity reader runs through one typed disposition owner in native, " +
      "scored, BM25 and highlight modes. Malformed hits are counted separately " +
      "from repeated passages and physical highlight copies.",
    enforcement: {
      kind: "function-call",
      name: "extractId",
      within: ["apps/api/src/lib/legal-search/", "apps/api/src/handlers/"],
      allowed: [],
    },
  },
  {
    id: "corpus-candidate-rehydration",
    capability: "Classifying eligible canonical search candidates",
    owner: [
      "apps/api/src/handlers/case-law/decisions/search.ts",
      "apps/api/src/lib/legal-search/corpus-index-provider.ts",
      "apps/api/src/lib/legal-search/corpus-rehydration-disposition.ts",
      "apps/api/src/handlers/legislation/search.ts",
    ],
    summary:
      "SQL gates content before it leaves the canonical read. " +
      "`partitionCorpusRehydration` returns eligible rows separately from id-only " +
      "dispositions, accumulated by the request through `recordCorpusRehydrationDispositions`.",
    enforcement: {
      kind: "import",
      specifiers: [
        "@/api/handlers/case-law/decisions/search",
        "@/api/lib/legal-search/corpus-index-provider",
        "@/api/handlers/legislation/search",
      ],
      names: [
        "candidateDecisionRowsStatement",
        "pageDecisionRowsStatement",
        "rehydrateCorpusIndexProviderCandidatesStatement",
        "legislationCandidateRowsStatement",
      ],
      allowed: [
        {
          path: "apps/api/src/mcp/generated/capability-dispatch/legislation.search.ts",
          reason:
            "Lazy-loads the handler endpoint; does not invoke its canonical-read statement exports.",
        },
        {
          path: "apps/api/src/tests/query-plans/registry.ts",
          reason:
            "Measures production canonical-read statements under the public reader role.",
        },
        {
          path: "apps/api/src/handlers/legislation/search-hydration.db.test.ts",
          reason:
            "Verifies the legislation read boundary and indexed statement plan.",
        },
        {
          path: "apps/api/src/handlers/case-law/decisions/search-hydration.db.test.ts",
          reason: "Verifies candidate eligibility with the public reader role.",
        },
      ],
    },
  },
  {
    id: "compact-uuid",
    capability: "Compacting a uuid into a URL segment and reading it back",
    owner: ["packages/uuid-codec/"],
    summary:
      "A public-law address falls back to the row id when the corpus holds no " +
      "slug for the row yet, and the case-law and statute readers mint those " +
      "segments independently: a second encoding would hand out links the " +
      "other reader resolves to nothing. The output is published in URLs, so " +
      "it is the contract — 22 unpadded base64url characters over the uuid's " +
      "16 bytes — held by property tests over every 16-byte id rather than " +
      "over the uuid versions in use today. Invalid input is a typed failure, " +
      "so a reader decides for itself whether an unreadable segment is a 404 " +
      "or a value to carry through.",
    enforcement: { kind: "none" },
  },
  {
    id: "field-value-write",
    capability: "Setting a document's field value for a member",
    owner: ["apps/api/src/lib/fields/write-field.ts"],
    summary:
      "REST, MCP, Kanban moves and chat all set a cell through `writeFieldValue`, " +
      "which checks the member's effective authority, takes the entity row lock " +
      "before the cell lock, marks the cell as manually edited and records the " +
      "audit event in one transaction. Writes to the field tables are table " +
      "writes, not imports, so the `no-direct-field-write/no-direct-field-write` " +
      "rule holds this row instead of `confine-owner`; it lists the modules " +
      "that write those tables for other operations.",
    enforcement: { kind: "none" },
  },
  {
    id: "gated-test-database",
    capability: "Opening a database client in a test",
    owner: ["apps/api/src/tests/gated-test-database.ts"],
    summary:
      "The Postgres-gated suites run in one process, so a client a suite " +
      "leaves open holds its connections until the run ends, and enough of " +
      "them exhaust the server in an unrelated suite. The owner opens a " +
      "suite's database with its cleanup and closes it after that cleanup " +
      "even when it throws, and scopes a test's extra sessions to the test. " +
      "`confine-owner` does not lint tests, so the " +
      "`bun-test-hygiene/no-unmanaged-database-client` rule holds this row " +
      "instead.",
    enforcement: { kind: "none" },
  },
  {
    id: "failure-observation",
    capability: "Reading, grading and emitting an API failure",
    owner: [
      "packages/errors/src/failure.ts",
      "apps/api/src/lib/observability/failure-evidence.ts",
      "apps/api/src/lib/observability/failure.ts",
      "apps/api/src/lib/observability/observe-failure.ts",
      "apps/api/src/lib/observability/failure-shadow.ts",
    ],
    summary:
      "One bounded, read-once evidence snapshot per error feeds every failure " +
      "sink, so no sink can drop the cause, the SQLSTATE or the provider " +
      "status another one keeps. A finite reason decides the grade through one " +
      "policy map; boundaries classify what they know through an owned brand " +
      "rather than a property a foreign error could carry. observeFailure " +
      "composes the record, owned fields last, and owns severity, capture and " +
      "the transient metric. The direct-failure-sinks ratchet counts the " +
      "emissions still outside it, per file.",
    enforcement: { kind: "none" },
  },
  {
    id: "unchecked-public-response-handler",
    capability: "Public route handlers without the 200-schema exactness guard",
    owner: ["apps/api/src/lib/api-handlers.ts"],
    summary:
      "`createSafeBoundedPublicHandler` requires a route's 200 schema and its " +
      "handler's success payload to be mutually assignable, so the schema Eden " +
      "types the client from cannot be looser than the data. The unchecked " +
      "core exists for a factory whose result type is still generic where it " +
      "builds the handler; that factory applies the guard on its own entry points.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/api-handlers"],
      names: ["createSafeUncheckedBoundedPublicHandler"],
      allowed: [
        {
          path: "apps/api/src/handlers/case-law/decisions/public-subject.ts",
          reason:
            "Builds gated subject handlers generically and guards both entry points.",
        },
        {
          path: "apps/api/src/lib/safe-handler-factories.type-test.ts",
          reason:
            "Reads the module's export names at type level to bind the factory map; calls nothing.",
        },
      ],
    },
  },
  {
    id: "publisher-read",
    capability: "Reading a case-law publisher response",
    owner: [
      "apps/api/src/lib/errors/read-outcome.ts",
      "apps/api/src/handlers/case-law/ingestion/adapters/publisher-read.ts",
      "apps/api/src/handlers/case-law/ingestion/adapters/retry.ts",
    ],
    summary:
      "readPublisher sends the gated publisher request and returns a ReadOutcome: " +
      "the response, an absence only the publisher stated (404 or 410), or a " +
      "failure to read, so no helper can return a failed read as an empty " +
      "result. Raw fetchPublisher and fetchWithRetry callers are the adapters " +
      "not yet migrated; the list only shrinks. The read-fault guard drives " +
      "every enrolled adapter's reads with failures.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/handlers/case-law/ingestion/adapters/retry"],
      names: ["fetchPublisher", "fetchWithRetry"],
      allowed: [
        ...UNMIGRATED_PUBLISHER_READERS.map((file) => ({
          path: `apps/api/src/${file}`,
          reason:
            "Reads its publisher raw; pending migration to readPublisher.",
        })),
        {
          path: "apps/api/src/handlers/case-law/ingestion/adapters/at-courts.ts",
          reason:
            "Types the injected publisher fetch of its RIS walk; sends no request itself.",
        },
        {
          path: "apps/api/src/handlers/case-law/ingestion/adapters/at-findok.ts",
          reason:
            "Types the injected publisher fetch of its document reads; sends no request itself.",
        },
      ],
    },
  },
  ...ROOT_CONNECTION_DOORS,
] as const satisfies readonly OwnershipEntry[];

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

export const OWNERSHIP = OWNERSHIP_DECLARATIONS.map(withSchemaIntrospection);

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
  const rendered = await formattedLikeRepository(
    renderOwnershipDocument(OWNERSHIP),
    "md",
  );
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

  const { validateSchemaIntrospection } =
    await import("./schema-introspection.ts");
  const problems = [
    ...validateOwnership(OWNERSHIP, REPO_ROOT),
    ...validateSchemaIntrospection({
      entries: SCHEMA_INTROSPECTION,
      repoRoot: REPO_ROOT,
    }),
  ];
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
  process.exit(await main(process.argv.slice(2)));
}
