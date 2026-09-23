// Parsers take a `ScannedFile`, and a `ScannedFile` can only be minted by
// scanning bytes or by reading them back from a `FileKey`. Types enforce the
// rest; this rule closes the two ways around them:
//
//   bytes as ScannedFile                   // forged proof of a scan
//   key as unknown as FileKey              // staging key passed off as stored
//   <FileKey>key                           // angle-bracket spelling of the same
//   v.parse(fileKeySchema, stagingKey)     // the brand's own schema, reused
//   mintScannedFile({ ... })               // the scan module's mint, reused
//   Object.create(ScannedFile.prototype)   // instance without the constructor
//
// Neither brand needs a cast: `FileKey` is a valibot brand and `ScannedFile` a
// class with a private constructor, so casts are banned everywhere. Only
// `tests/helpers/file-key.ts` may import the key schema, and only
// `lib/file-scan/scan-upload.ts` the scan mint, so a raw upload cannot reach a
// parser unscanned.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const BRANDED_TYPES = new Set(["ScannedFile", "FileKey"]);

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
      owners: ["apps/api/src/lib/file-scan/scan-upload.ts"],
    },
  ],
]);

const brandedTypeName = (typeAnnotation: unknown): string | null => {
  if (
    !isAstNode(typeAnnotation) ||
    typeAnnotation.type !== "TSTypeReference" ||
    !isIdentifier(typeAnnotation.typeName)
  ) {
    return null;
  }
  const { name } = typeAnnotation.typeName;
  return BRANDED_TYPES.has(name) ? name : null;
};

export default eslintCompatPlugin({
  meta: { name: "scanned-file-boundary" },
  rules: {
    "scanned-file-boundary": {
      meta: {
        type: "problem",
        messages: {
          forgedBrand:
            "Do not cast to {{name}}. Obtain a ScannedFile from scanUpload " +
            "or storedFile, and a FileKey from createFileKey or " +
            "createUserFileKey, so unscanned bytes cannot reach a parser.",
          mintImport:
            "Do not import mintScannedFile; use scanUpload or storedFile.",
          schemaImport:
            "Do not import fileKeySchema; build keys with createFileKey or " +
            "createUserFileKey (tests: testFileKey).",
          prototypeAccess:
            "Do not build a ScannedFile from its prototype; use scanUpload " +
            "or storedFile.",
        },
      },
      createOnce(context) {
        const filenameEndsWithAny = (suffixes: readonly string[]): boolean => {
          const filename = filenameForContext(context);
          return suffixes.some((suffix) => filename.endsWith(suffix));
        };
        return {
          before() {
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
            const restricted = RESTRICTED_IMPORTS.get(node.source.value);
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
          TSAsExpression(node) {
            const name = brandedTypeName(node.typeAnnotation);
            if (name !== null) {
              context.report({
                node,
                messageId: "forgedBrand",
                data: { name },
              });
            }
          },
          TSTypeAssertion(node) {
            const name = brandedTypeName(node.typeAnnotation);
            if (name !== null) {
              context.report({
                node,
                messageId: "forgedBrand",
                data: { name },
              });
            }
          },
          MemberExpression(node) {
            if (
              isIdentifier(node.object, "ScannedFile") &&
              isIdentifier(node.property, "prototype")
            ) {
              context.report({ node, messageId: "prototypeAccess" });
            }
          },
        };
      },
    },
  },
});
