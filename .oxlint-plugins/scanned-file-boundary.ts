// Parsers take a `ScannedFile`, and a `ScannedFile` can only be minted by
// scanning bytes or by reading them back from a `FileKey`. Types enforce the
// rest; this rule closes the ways around them:
//
//   bytes as ScannedFile                   // forged proof of a scan
//   key as unknown as FileKey              // staging key passed off as stored
//   <FileKey>key                           // angle-bracket spelling of the same
//   bytes as ParserFile                    // import alias of ScannedFile
//   bytes as scanned.ScannedFile           // namespace import
//   bytes as LocalAlias                    // `type LocalAlias = ScannedFile`
//   v.parse(fileKeySchema, stagingKey)     // the brand's own schema, reused
//   mintScannedFile({ ... })               // the mint, reused
//   Object.create(ScannedFile.prototype)   // instance without the constructor
//
// Neither brand needs a cast: `FileKey` is a valibot brand and `ScannedFile` a
// class with a private constructor, so casts are banned everywhere. The mint
// and the key schema may only be imported by the modules listed below.
//
// Casts are matched against local bindings: the canonical names, their import
// aliases, namespace imports of the owning modules, and same-file type aliases
// of any of those (declared before or after the cast). An alias re-exported
// from a third module is not resolved; `typescript/no-unsafe-type-assertion`
// still reports that cast.

import { eslintCompatPlugin, type Node } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const BRANDED_TYPES = new Set(["ScannedFile", "FileKey"]);

const BRAND_MODULES = new Set([
  "@/api/lib/file-key",
  "@/api/lib/file-scan/scanned-file",
]);

// Minting exports and the modules allowed to import them. The mint lives
// apart from the scanner so stored-file readers do not bundle the scanner.
const RESTRICTED_IMPORTS = new Map([
  [
    "@/api/lib/file-key",
    {
      name: "fileKeySchema",
      messageId: "schemaImport",
      owners: ["apps/api/src/tests/helpers/file-key.ts"],
    },
  ],
  [
    "@/api/lib/file-scan/scanned-file",
    {
      name: "mintScannedFile",
      messageId: "mintImport",
      owners: [
        "apps/api/src/lib/file-scan/scan-upload.ts",
        "apps/api/src/lib/file-scan/stored-file.ts",
        "apps/api/src/tests/helpers/scanned-file.ts",
      ],
    },
  ],
]);

type PendingCast = { node: Node; typeAnnotation: unknown };

export default eslintCompatPlugin({
  meta: { name: "scanned-file-boundary" },
  rules: {
    "scanned-file-boundary": {
      meta: {
        type: "problem",
        messages: {
          forgedBrand:
            "Do not cast to {{name}}. Obtain a ScannedFile from scanUpload " +
            "or readStoredFile, and a FileKey from createFileKey or " +
            "createUserFileKey, so unscanned bytes cannot reach a parser.",
          mintImport:
            "Do not import mintScannedFile; use scanUpload or readStoredFile.",
          schemaImport:
            "Do not import fileKeySchema; build keys with createFileKey or " +
            "createUserFileKey (tests: testFileKey).",
          prototypeAccess:
            "Do not build a ScannedFile from its prototype; use scanUpload " +
            "or readStoredFile.",
        },
      },
      createOnce(context) {
        const brandedLocals = new Map<string, string>();
        const brandNamespaces = new Set<string>();
        const typeAliases = new Map<string, unknown>();
        const pendingCasts: PendingCast[] = [];

        const filenameEndsWithAny = (suffixes: readonly string[]): boolean => {
          const filename = filenameForContext(context);
          return suffixes.some((suffix) => filename.endsWith(suffix));
        };

        // The brand a type annotation names, following same-file aliases.
        const brandOf = (
          typeAnnotation: unknown,
          seen: Set<string>,
        ): string | null => {
          if (
            !isAstNode(typeAnnotation) ||
            typeAnnotation.type !== "TSTypeReference"
          ) {
            return null;
          }
          const { typeName } = typeAnnotation;
          if (
            isAstNode(typeName) &&
            typeName.type === "TSQualifiedName" &&
            isIdentifier(typeName.left) &&
            brandNamespaces.has(typeName.left.name) &&
            isIdentifier(typeName.right) &&
            BRANDED_TYPES.has(typeName.right.name)
          ) {
            return typeName.right.name;
          }
          if (!isIdentifier(typeName)) {
            return null;
          }
          const brand = brandedLocals.get(typeName.name);
          if (brand !== undefined) {
            return brand;
          }
          const aliased = typeAliases.get(typeName.name);
          if (aliased === undefined || seen.has(typeName.name)) {
            return null;
          }
          seen.add(typeName.name);
          return brandOf(aliased, seen);
        };

        return {
          before() {
            brandedLocals.clear();
            for (const name of BRANDED_TYPES) {
              brandedLocals.set(name, name);
            }
            brandNamespaces.clear();
            typeAliases.clear();
            pendingCasts.length = 0;
            const filename = filenameForContext(context);
            return (
              filename.includes("apps/api/src/") ||
              filename.endsWith(
                ".oxlint-plugins/__fixtures__/scanned-file-boundary.fixture.ts",
              )
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            const source = node.source.value;
            if (BRAND_MODULES.has(source)) {
              for (const specifier of node.specifiers) {
                if (
                  isAstNode(specifier) &&
                  specifier.type === "ImportNamespaceSpecifier" &&
                  isIdentifier(specifier.local)
                ) {
                  brandNamespaces.add(specifier.local.name);
                  continue;
                }
                const imported = getImportedName(specifier);
                const local = getImportLocalName(specifier);
                if (
                  imported !== null &&
                  local !== null &&
                  BRANDED_TYPES.has(imported)
                ) {
                  brandedLocals.set(local, imported);
                }
              }
            }
            const restricted = RESTRICTED_IMPORTS.get(source);
            if (
              restricted === undefined ||
              filenameEndsWithAny(restricted.owners)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (getImportedName(specifier) === restricted.name) {
                context.report({
                  node: specifier,
                  messageId: restricted.messageId,
                });
              }
            }
          },
          TSTypeAliasDeclaration(node) {
            if (isIdentifier(node.id)) {
              typeAliases.set(node.id.name, node.typeAnnotation);
            }
          },
          // Aliases may be declared after the cast, so casts are resolved
          // once the whole file has been read.
          TSAsExpression(node) {
            pendingCasts.push({ node, typeAnnotation: node.typeAnnotation });
          },
          TSTypeAssertion(node) {
            pendingCasts.push({ node, typeAnnotation: node.typeAnnotation });
          },
          MemberExpression(node) {
            if (
              isIdentifier(node.property, "prototype") &&
              isIdentifier(node.object) &&
              brandedLocals.get(node.object.name) === "ScannedFile"
            ) {
              context.report({ node, messageId: "prototypeAccess" });
            }
          },
          "Program:exit"() {
            for (const { node, typeAnnotation } of pendingCasts) {
              const name = brandOf(typeAnnotation, new Set());
              if (name !== null) {
                context.report({
                  node,
                  messageId: "forgedBrand",
                  data: { name },
                });
              }
            }
          },
        };
      },
    },
  },
});
