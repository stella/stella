// Keep every document run queue on its one owner.
//
// A document run is a row a member queued over one document (a review, a list
// verification, a fact extraction, a translation), executed once by a BullMQ
// worker. `apps/api/src/lib/queue/document-run-queue.ts` owns that skeleton:
// one attempt, the run id as the job id, the time budget, the stuck rules, the
// worker's failure path and the recovery sweeps. A module that reads a
// document run table and also builds a BullMQ queue or worker by hand would
// grow a second copy of it, so the rule reports the construction imports in
// such a module.
//
// Flags, in a module that imports a document run table from the schema
// (by name, or read through a namespace import of it):
//   import { BullMqWorker } from "@/api/lib/bullmq-queue";
//   import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
//   import * as queues from "@/api/lib/bullmq-queue";
//   import { Queue } from "bullmq";
//
// Allows:
//   import { createDocumentRunQueue } from "@/api/lib/queue/document-run-queue";
//   the same imports in a module that reads no document run table.
//
// Detection boundary: imports only. A module that builds the queue in one file
// and reads the table in another is not seen; `scripts/queue-authority.ts`
// still requires every worker to be registered.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { canonicalModuleId } from "./module-id.ts";
import {
  getImportedName,
  isAstNode,
  isIdentifier,
  memberPropertyName,
  repoRelativeFilename,
} from "./utils.ts";

const RULE_NAME = "no-hand-built-document-run-queue";

const OWNER = "apps/api/src/lib/queue/document-run-queue.ts";

/** The schema exports that are document run tables. */
const DOCUMENT_RUN_TABLES: ReadonlySet<string> = new Set([
  "bilingualTranslationRuns",
  "documentReviewRuns",
  "documentTranslationRuns",
  "legalListGenerationRuns",
  "legalListVerificationRuns",
]);

/**
 * Queues still built by hand, each to move onto the owner. Shrink-only: a
 * module leaves the list in the change that moves it.
 */
const BACKLOG: ReadonlySet<string> = new Set([
  "apps/api/src/lib/bilingual/run-queue.ts",
  "apps/api/src/lib/document-translation/run-queue.ts",
  "apps/api/src/lib/lists/generation/run-queue.ts",
]);

const BULLMQ_QUEUE_MODULE = "apps/api/src/lib/bullmq-queue";
const HAND_BUILT_NAMES: ReadonlySet<string> = new Set([
  "BullMqWorker",
  "createLazyBullMqQueue",
]);
const RAW_BULLMQ_NAMES: ReadonlySet<string> = new Set(["Queue", "Worker"]);

const isSchemaModule = (module: string) =>
  module === "apps/api/src/db/schema" ||
  module.startsWith("apps/api/src/db/schema/");

const sourceOf = (node: unknown): string | null =>
  isAstNode(node) &&
  isAstNode(node.source) &&
  typeof node.source.value === "string"
    ? node.source.value
    : null;

const specifiersOf = (node: unknown): readonly unknown[] =>
  isAstNode(node) && Array.isArray(node.specifiers) ? node.specifiers : [];

const isTypeOnly = (node: unknown): boolean =>
  isAstNode(node) && node.importKind === "type";

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          handBuilt:
            "A document run queue is built by createDocumentRunQueue (apps/api/src/lib/queue/document-run-queue.ts); a module that reads a document run table does not construct a BullMQ queue or worker itself.",
        },
        schema: [],
      },
      createOnce(context) {
        let skipped = true;
        let imports: unknown[] = [];
        let readsRunTable = false;
        /** Local names of namespace imports of the schema. */
        let schemaNamespaces = new Set<string>();
        return {
          Program(program) {
            const file = repoRelativeFilename(context);
            skipped = file === OWNER || BACKLOG.has(file);
            imports = (
              isAstNode(program) && Array.isArray(program.body)
                ? program.body
                : []
            ).filter(
              (statement) =>
                isAstNode(statement) &&
                statement.type === "ImportDeclaration" &&
                !isTypeOnly(statement),
            );
            readsRunTable = false;
            schemaNamespaces = new Set();
            for (const statement of imports) {
              const source = sourceOf(statement);
              if (
                source === null ||
                !isSchemaModule(canonicalModuleId(source, file))
              ) {
                continue;
              }
              for (const specifier of specifiersOf(statement)) {
                if (!isAstNode(specifier) || isTypeOnly(specifier)) {
                  continue;
                }
                if (
                  specifier.type === "ImportNamespaceSpecifier" &&
                  isIdentifier(specifier.local)
                ) {
                  schemaNamespaces.add(specifier.local.name);
                }
                const name = getImportedName(specifier);
                if (name !== null && DOCUMENT_RUN_TABLES.has(name)) {
                  readsRunTable = true;
                }
              }
            }
          },
          MemberExpression(node) {
            if (
              !readsRunTable &&
              isAstNode(node) &&
              isIdentifier(node.object) &&
              schemaNamespaces.has(node.object.name)
            ) {
              const table = memberPropertyName(node);
              readsRunTable = table !== null && DOCUMENT_RUN_TABLES.has(table);
            }
          },
          "Program:exit"() {
            if (skipped || !readsRunTable) {
              return;
            }
            const file = repoRelativeFilename(context);
            for (const statement of imports) {
              const source = sourceOf(statement);
              if (source === null) {
                continue;
              }
              const module = canonicalModuleId(source, file);
              const names =
                module === BULLMQ_QUEUE_MODULE
                  ? HAND_BUILT_NAMES
                  : source === "bullmq"
                    ? RAW_BULLMQ_NAMES
                    : null;
              if (names === null) {
                continue;
              }
              for (const specifier of specifiersOf(statement)) {
                if (!isAstNode(specifier) || isTypeOnly(specifier)) {
                  continue;
                }
                const name = getImportedName(specifier);
                if (
                  specifier.type === "ImportNamespaceSpecifier" ||
                  (name !== null && names.has(name))
                ) {
                  context.report({ node: specifier, messageId: "handBuilt" });
                }
              }
            }
          },
        };
      },
    },
  },
});
