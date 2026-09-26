// Server code writes PDF bytes a person keeps through `savePdfRewrite`
// (`apps/api/src/lib/files/pdf-signatures.ts`), which refuses to rewrite a
// signed or encrypted file. This rule reports the ways around it:
//
//   pdf.save(), pdf?.save(), pdf["save"](), const write = pdf.save
//   const { save } = pdf
//   (await PDF.load(bytes)).save(), PDF.prototype.save
//   import ... from "pdf-lib" (or another PDF writer package)
//   Bun.spawn(["qpdf", ...]), $`gs ...` (a PDF-rewriting command line)
//
// A "PDF document" is a binding initialised from `PDF.load/create/merge` of the
// `@libpdf/core` import (any local name), from any `.extractPages(...)`, or
// declared with the `PDF` type. Detection boundary: syntax only, per file and
// by binding name, so a document reached through a function's return value, an
// object property, or another module's export is out of scope. A transient
// copy that only goes to a model as input uses `savePdfForModelInput` from the
// same module. Client code (`apps/web`) is not covered.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  isTestFile,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-direct-pdf-save";
/**
 * The two helpers that save without the signed/encrypted refusal, and the
 * only modules that may import them: an incremental revision for the
 * signing pipeline, and transient copies that only go to a model.
 */
const HELPER_MODULE_SUFFIX = "/files/pdf-signatures";
const RESTRICTED_HELPERS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "appendSigningRevision",
    ["apps/api/src/lib/files/pdf-signing/validation-data.ts"],
  ],
  [
    "savePdfForModelInput",
    [
      "apps/api/src/lib/bbox/generate-b-boxes.ts",
      "apps/api/src/lib/workflow/generate-batch.ts",
    ],
  ],
]);
const OWNER_PATH = "apps/api/src/lib/files/pdf-signatures.ts";
const FIXTURE_FILE_SUFFIX =
  ".oxlint-plugins/__fixtures__/no-direct-pdf-save.fixture.ts";
const LIBPDF = "@libpdf/core";
const DOCUMENT_FACTORIES = new Set(["create", "load", "merge"]);
const OTHER_PDF_WRITERS = new Set([
  "@cantoo/pdf-lib",
  "hummus",
  "muhammara",
  "mupdf",
  "pdf-lib",
  "pdfkit",
]);
const PDF_REWRITE_COMMANDS = new Set([
  "cpdf",
  "gs",
  "gswin64c",
  "mutool",
  "ocrmypdf",
  "pdfcpu",
  "pdftk",
  "qpdf",
]);

const isCommandText = (text: unknown): boolean =>
  typeof text === "string" &&
  PDF_REWRITE_COMMANDS.has(text.trim().split(/\s+/u).at(0) ?? "");

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          directSave:
            "Save PDF documents through savePdfRewrite from @/api/lib/files/pdf-signatures.",
          otherWriter:
            "Write PDFs through @libpdf/core and savePdfRewrite from @/api/lib/files/pdf-signatures.",
          restrictedHelper:
            "This save helper is reserved for its owning module; use savePdfRewrite from @/api/lib/files/pdf-signatures.",
        },
        schema: [],
      },
      createOnce(context) {
        // Local names of the `PDF` class imported from libpdf.
        const pdfClassNames = new Set<string>();
        // Bindings that hold a PDF document.
        const documentNames = new Set<string>();

        const isPdfClass = (node: unknown): boolean => {
          const expression = unwrapExpression(node);
          return isIdentifier(expression) && pdfClassNames.has(expression.name);
        };

        const isPdfTypeAnnotation = (node: unknown): boolean => {
          if (!isAstNode(node) || node.type !== "TSTypeAnnotation") {
            return false;
          }
          const type = node.typeAnnotation;
          return (
            isAstNode(type) &&
            type.type === "TSTypeReference" &&
            isIdentifier(type.typeName) &&
            pdfClassNames.has(type.typeName.name)
          );
        };

        const isDocumentExpression = (node: unknown): boolean => {
          let expression = unwrapExpression(node);
          if (expression?.type === "AwaitExpression") {
            expression = unwrapExpression(expression.argument);
          }
          if (isIdentifier(expression)) {
            return documentNames.has(expression.name);
          }
          if (expression?.type !== "CallExpression") {
            return false;
          }
          const callee = unwrapExpression(expression.callee);
          if (callee?.type !== "MemberExpression") {
            return false;
          }
          const method = getPropertyName(callee.property);
          return (
            method === "extractPages" ||
            (method !== null &&
              DOCUMENT_FACTORIES.has(method) &&
              isPdfClass(callee.object))
          );
        };

        const isSaveReceiver = (node: unknown): boolean => {
          const receiver = unwrapExpression(node);
          if (
            receiver?.type === "MemberExpression" &&
            getPropertyName(receiver.property) === "prototype"
          ) {
            return isPdfClass(receiver.object);
          }
          return isDocumentExpression(receiver);
        };

        const rememberBinding = (id: unknown, init: unknown) => {
          if (!isIdentifier(id)) {
            return;
          }
          if (
            isPdfTypeAnnotation(id.typeAnnotation) ||
            (init !== undefined && isDocumentExpression(init))
          ) {
            documentNames.add(id.name);
          }
        };

        const rememberParams = (params: unknown) => {
          if (!Array.isArray(params)) {
            return;
          }
          for (const param of params) {
            rememberBinding(param, undefined);
          }
        };

        return {
          before() {
            pdfClassNames.clear();
            documentNames.clear();
            const filename = filenameForContext(context);
            if (filename.endsWith(FIXTURE_FILE_SUFFIX)) {
              return true;
            }
            return (
              filename.includes("apps/api/src/") &&
              !filename.endsWith(OWNER_PATH) &&
              !isTestFile(filename)
            );
          },
          ImportDeclaration(node) {
            if (!isStringLiteral(node.source)) {
              return;
            }
            if (OTHER_PDF_WRITERS.has(node.source.value)) {
              context.report({ node, messageId: "otherWriter" });
              return;
            }
            if (
              node.source.value.endsWith(HELPER_MODULE_SUFFIX) &&
              Array.isArray(node.specifiers)
            ) {
              const filename = filenameForContext(context);
              for (const specifier of node.specifiers) {
                const owners = RESTRICTED_HELPERS.get(
                  getImportedName(specifier) ?? "",
                );
                if (
                  owners !== undefined &&
                  !owners.some((owner) => filename.endsWith(owner))
                ) {
                  context.report({
                    node: specifier,
                    messageId: "restrictedHelper",
                  });
                }
              }
              return;
            }
            if (
              node.source.value !== LIBPDF ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                getImportedName(specifier) === "PDF" &&
                isAstNode(specifier) &&
                isIdentifier(specifier.local)
              ) {
                pdfClassNames.add(specifier.local.name);
              }
            }
          },
          ImportExpression(node) {
            if (
              isStringLiteral(node.source) &&
              OTHER_PDF_WRITERS.has(node.source.value)
            ) {
              context.report({ node, messageId: "otherWriter" });
            }
          },
          FunctionDeclaration(node) {
            rememberParams(node.params);
          },
          FunctionExpression(node) {
            rememberParams(node.params);
          },
          ArrowFunctionExpression(node) {
            rememberParams(node.params);
          },
          VariableDeclarator(node) {
            const { id, init } = node;
            rememberBinding(id, init ?? undefined);
            if (
              isAstNode(id) &&
              id.type === "ObjectPattern" &&
              Array.isArray(id.properties) &&
              isSaveReceiver(init) &&
              id.properties.some(
                (property) =>
                  isAstNode(property) &&
                  property.type === "Property" &&
                  getPropertyName(property.key) === "save",
              )
            ) {
              context.report({ node, messageId: "directSave" });
            }
          },
          MemberExpression(node) {
            if (
              getPropertyName(node.property) === "save" &&
              isSaveReceiver(node.object)
            ) {
              context.report({ node, messageId: "directSave" });
            }
          },
          ArrayExpression(node) {
            const first = Array.isArray(node.elements)
              ? node.elements.at(0)
              : undefined;
            if (isStringLiteral(first) && isCommandText(first.value)) {
              context.report({ node, messageId: "otherWriter" });
            }
          },
          TaggedTemplateExpression(node) {
            const quasis = isAstNode(node.quasi)
              ? node.quasi.quasis
              : undefined;
            const head = Array.isArray(quasis) ? quasis.at(0) : undefined;
            const value = isAstNode(head) ? head.value : undefined;
            const cooked =
              typeof value === "object" && value !== null && "cooked" in value
                ? value.cooked
                : undefined;
            if (isCommandText(cooked)) {
              context.report({ node, messageId: "otherWriter" });
            }
          },
        };
      },
    },
  },
});
