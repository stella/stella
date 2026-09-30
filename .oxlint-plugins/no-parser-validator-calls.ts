import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";
import { panic } from "better-result";

import ledger from "../scripts/parser-validator-call-ledger.json" with { type: "json" };
import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-parser-validator-calls";
const VALIDATOR_NAMES = new Set(["validateAndLog", "validateAst"]);
const ORACLE_MODULE = /(?:^|\/)validate-ast(?:\.[cm]?[jt]s)?$/u;
const LEDGER_PATH = "scripts/parser-validator-call-ledger.json";

// Each file has a separate import and call budget. Adding a call to an
// existing caller still fails; removing one requires deleting its ledger row.
// The ratchet prevents the combined ledger budget from growing.
const ledgerByFile = new Map<string, Set<string>>();
for (const [index, entry] of ledger.entries()) {
  const previous = ledger.at(index - 1);
  if (index > 0 && previous !== undefined && previous >= entry) {
    panic(`${LEDGER_PATH} must be sorted and duplicate-free`);
  }
  const [file, kind, ordinal] = entry.split("::");
  if (
    file === undefined ||
    (kind !== "import" && kind !== "call") ||
    ordinal === undefined ||
    !/^[1-9]\d*$/u.test(ordinal)
  ) {
    panic(`${LEDGER_PATH} contains an invalid entry: ${entry}`);
  }
  const budget = ledgerByFile.get(file) ?? new Set<string>();
  budget.add(`${kind}::${ordinal}`);
  ledgerByFile.set(file, budget);
}

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          parserValidator:
            "Text-retention validation belongs to the ingestion pipeline. Parsers and adapters must not import the oracle or call validateAndLog/validateAst.",
          staleLedger:
            "Remove {{entry}} from scripts/parser-validator-call-ledger.json: this validator import or call no longer exists.",
        },
        schema: [],
      },
      createOnce(context) {
        let budget = new Set<string>();
        let ledgerFile = "";
        let seen = new Set<string>();
        let imports = 0;
        let calls = 0;
        let aliases = new Set<string>();

        const record = (node: Ranged, kind: "import" | "call") => {
          const ordinal = kind === "import" ? ++imports : ++calls;
          const entry = `${kind}::${ordinal}`;
          seen.add(entry);
          if (!budget.has(entry)) {
            context.report({ node, messageId: "parserValidator" });
          }
        };

        const isValidatorImport = (node: unknown): boolean => {
          if (!isAstNode(node) || node.importKind === "type") {
            return false;
          }
          const source = staticStringValue(node.source);
          if (source !== null && ORACLE_MODULE.test(source)) {
            return (
              !Array.isArray(node.specifiers) ||
              node.specifiers.length === 0 ||
              node.specifiers.some(
                (specifier) =>
                  specifier.importKind !== "type" &&
                  specifier.exportKind !== "type",
              )
            );
          }
          return (
            Array.isArray(node.specifiers) &&
            node.specifiers.some((specifier) => {
              const imported = getImportedName(specifier);
              return (
                specifier.importKind !== "type" &&
                imported !== null &&
                VALIDATOR_NAMES.has(imported)
              );
            })
          );
        };

        return {
          before() {
            const filename = filenameForContext(context);
            ledgerFile = "";
            budget = new Set();
            seen = new Set();
            aliases = new Set(VALIDATOR_NAMES);
            imports = 0;
            calls = 0;
            for (const [file, entries] of ledgerByFile) {
              if (filename === file || filename.endsWith(`/${file}`)) {
                ledgerFile = file;
                budget = entries;
                break;
              }
            }
          },
          // Resolve aliases before calls, including calls above hoisted imports.
          Program(node) {
            for (const statement of node.body) {
              if (
                statement.type !== "ImportDeclaration" ||
                !isValidatorImport(statement)
              ) {
                continue;
              }
              for (const specifier of statement.specifiers) {
                const imported = getImportedName(specifier);
                const local = getImportLocalName(specifier);
                if (
                  imported !== null &&
                  VALIDATOR_NAMES.has(imported) &&
                  local !== null
                ) {
                  aliases.add(local);
                }
              }
            }
          },
          ImportDeclaration(node) {
            if (isValidatorImport(node)) {
              record(node, "import");
            }
          },
          ExportNamedDeclaration(node) {
            if (node.exportKind !== "type" && isValidatorImport(node)) {
              record(node, "import");
            }
          },
          ExportAllDeclaration(node) {
            if (node.exportKind !== "type" && isValidatorImport(node)) {
              record(node, "import");
            }
          },
          ImportExpression(node) {
            const source = staticStringValue(node.source);
            if (source !== null && ORACLE_MODULE.test(source)) {
              record(node, "import");
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (isIdentifier(callee) && aliases.has(callee.name)) {
              record(node, "call");
              return;
            }
            if (isAstNode(callee) && callee.type === "MemberExpression") {
              const name = getPropertyName(callee.property);
              if (name !== null && VALIDATOR_NAMES.has(name)) {
                record(node, "call");
              }
            }
            if (isIdentifier(callee, "require")) {
              const source = staticStringValue(node.arguments.at(0));
              if (source !== null && ORACLE_MODULE.test(source)) {
                record(node, "import");
              }
            }
          },
          "Program:exit"(node) {
            for (const entry of budget) {
              if (!seen.has(entry)) {
                context.report({
                  node: node.body.at(0) ?? node,
                  messageId: "staleLedger",
                  data: { entry: `${ledgerFile}::${entry}` },
                });
              }
            }
          },
        };
      },
    },
  },
});
