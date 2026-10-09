// A chat reference (file, task, folder, matter, decision, skill, person) must
// render through `ReferenceChip` in `apps/web/src/components/references/`. The
// composer node view, the sent user message and the assistant's markdown each
// once built their own chip: the composer filled the chip with the matter
// colour, the transcript drew it grey, and the same task looked like two
// different things in one conversation.
//
// Two signals, both outside the references module:
//
// 1. Chip shell + reference glyph. A file that renders a chip shell (the
//    inline `InlinePill`, or a TipTap `NodeViewWrapper`) and also renders a
//    reference glyph (`MatterIcon`, `EntityIcon`, `EntityKindIcon`,
//    `DocumentIcon`, `SkillIcon`, `LandmarkIcon`, `UserIdentity`,
//    `UserIdentityAvatar`, `PersonMentionLabel`) is building a reference chip
//    by hand. The pairing is checked per file, so a glyph bound to a variable
//    first (`const icon = <MatterIcon … />`) is still caught. Shells alone
//    (anonymization pills, citation chips with file/mail/globe glyphs, paste
//    chips) and glyphs alone (tables, pickers, headers) stay legal.
// 2. The reference href codec. Parsing or building `#stella-entity=`,
//    `#stella-workspace=`, `#stella-decision…` or `#stella-user=` links (the
//    `@stll/api-contract` codec, or a string or template literal that spells
//    one of those prefixes) belongs to the references module, which turns
//    every source into the one reference value the chip renders.
//
// Tests are exempt: they spell hrefs as fixtures.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isStringLiteral,
  isTestFile,
  jsxName,
  type AstNode,
} from "./utils.ts";

const REFERENCES_MODULE = "apps/web/src/components/references/";
const FIXTURE_SUFFIX =
  ".oxlint-plugins/__fixtures__/no-hand-rolled-reference-chip.fixture.tsx";

// module specifier -> exported names that draw a reference's glyph
const REFERENCE_GLYPHS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["@stll/ui/matter-icon", new Set(["MatterIcon"])],
  [
    "@/components/workspaces/entity-kind-icon",
    new Set(["EntityIcon", "EntityKindIcon"]),
  ],
  ["@/components/document-icon", new Set(["DocumentIcon"])],
  ["@stll/ui/icons", new Set(["SkillIcon", "LandmarkIcon"])],
  ["@/components/user-avatar", new Set(["UserIdentity", "UserIdentityAvatar"])],
  ["@/components/person-mention-label", new Set(["PersonMentionLabel"])],
]);

// module specifier -> exported names that are an inline chip's shell
const CHIP_SHELLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["@/components/inline-pill", new Set(["InlinePill"])],
  ["@tiptap/react", new Set(["NodeViewWrapper"])],
]);

const HREF_CODEC_MODULE = "@stll/api-contract";
const HREF_CODEC_NAMES: ReadonlySet<string> = new Set([
  "CHAT_MENTION_HREF_PREFIXES",
  "CHAT_REFERENCE_HREF_PREFIXES",
  "CHAT_RESOURCE_HREF_PREFIX",
  "parseCanonicalChatResourceHref",
  "parseChatDecisionPassageHref",
  "parseChatResourceHref",
  "toChatMentionResourceHref",
  "toChatResourceHref",
]);
const REFERENCE_HREF_PREFIXES = [
  "#stella-entity",
  "#stella-workspace",
  "#stella-decision",
  "#stella-user=",
] as const;

const startsWithReferencePrefix = (value: string): boolean =>
  REFERENCE_HREF_PREFIXES.some((prefix) => value.startsWith(prefix));

const templateHead = (node: AstNode): string | null => {
  const quasis = node.quasis;
  if (!Array.isArray(quasis)) {
    return null;
  }
  const first: unknown = quasis.at(0);
  // A quasi's `value` is a plain `{ raw, cooked }` record, not an AST node.
  if (!isAstNode(first) || typeof first.value !== "object") {
    return null;
  }
  const raw: unknown =
    first.value === null ? undefined : Reflect.get(first.value, "raw");
  return typeof raw === "string" ? raw : null;
};

const importedFrom = (
  table: ReadonlyMap<string, ReadonlySet<string>>,
  source: string,
  name: string,
): boolean => table.get(source)?.has(name) === true;

export default eslintCompatPlugin({
  meta: { name: "no-hand-rolled-reference-chip" },
  rules: {
    "no-hand-rolled-reference-chip": {
      meta: {
        type: "problem",
        messages: {
          handRolledChip:
            "Do not build a reference chip from {{shell}} and {{glyph}}. " +
            "Render ReferenceChip (or MarkdownReferenceChip) from " +
            "'@/components/references/reference-chip' so every surface " +
            "shows a reference the same way.",
          hrefCodec:
            "Reference hrefs are parsed and built only in " +
            "'@/components/references/'. Convert the source with a " +
            "reference.logic converter instead of {{name}}.",
        },
      },
      createOnce(context) {
        const glyphLocals = new Set<string>();
        const shellLocals = new Set<string>();
        const glyphElements: AstNode[] = [];
        let shellName: string | null = null;

        return {
          before() {
            glyphLocals.clear();
            shellLocals.clear();
            glyphElements.length = 0;
            shellName = null;
            const filename = filenameForContext(context);
            if (filename.endsWith(FIXTURE_SUFFIX)) {
              return true;
            }
            return (
              filename.includes("apps/web/src/") &&
              !filename.includes(REFERENCES_MODULE) &&
              !isTestFile(filename)
            );
          },
          ImportDeclaration(node) {
            const source = node.source;
            if (!isStringLiteral(source) || !Array.isArray(node.specifiers)) {
              return;
            }
            const typeOnlyDeclaration = node.importKind === "type";
            for (const specifier of node.specifiers) {
              const imported = getImportedName(specifier);
              const local = getImportLocalName(specifier);
              if (imported === null || local === null) {
                continue;
              }
              if (importedFrom(REFERENCE_GLYPHS, source.value, imported)) {
                glyphLocals.add(local);
              }
              if (importedFrom(CHIP_SHELLS, source.value, imported)) {
                shellLocals.add(local);
              }
              const typeOnly =
                typeOnlyDeclaration ||
                (isAstNode(specifier) && specifier.importKind === "type");
              if (
                !typeOnly &&
                source.value === HREF_CODEC_MODULE &&
                HREF_CODEC_NAMES.has(imported)
              ) {
                context.report({
                  node: specifier,
                  messageId: "hrefCodec",
                  data: { name: imported },
                });
              }
            }
          },
          Literal(node) {
            if (
              typeof node.value === "string" &&
              startsWithReferencePrefix(node.value)
            ) {
              context.report({
                node,
                messageId: "hrefCodec",
                data: { name: JSON.stringify(node.value) },
              });
            }
          },
          TemplateLiteral(node) {
            if (!isAstNode(node)) {
              return;
            }
            const head = templateHead(node);
            if (head !== null && startsWithReferencePrefix(head)) {
              context.report({
                node,
                messageId: "hrefCodec",
                data: { name: `\`${head}…\`` },
              });
            }
          },
          JSXOpeningElement(node) {
            const name = jsxName(node.name);
            if (name === null) {
              return;
            }
            if (glyphLocals.has(name) && isAstNode(node)) {
              glyphElements.push(node);
            }
            if (shellLocals.has(name)) {
              shellName ??= name;
            }
          },
          "Program:exit"() {
            if (shellName === null) {
              return;
            }
            for (const element of glyphElements) {
              context.report({
                node: element,
                messageId: "handRolledChip",
                data: {
                  shell: shellName,
                  glyph: jsxName(element.name) ?? "a reference glyph",
                },
              });
            }
          },
        };
      },
    },
  },
});
