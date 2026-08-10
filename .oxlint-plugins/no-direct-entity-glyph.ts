// An entity's glyph must come from its kind, through one component.
// `<EntityKindIcon>` (apps/web/src/components/workspaces/entity-kind-icon.tsx)
// is the only sanctioned way to draw one: its `switch` is exhaustive over
// `EntityKind`, so a new kind cannot silently inherit another's glyph, and
// its `EntityIcon` wrapper makes "not resolved yet" a state of its own
// rather than a document.
//
// Hand-rolled dispatches drew chat mentions of folders and tasks as
// documents (#1720) because each one branched on a proxy signal (the label
// text, the presence of a mime type) or covered only "folder". Banning the
// raw kind-bearing glyphs makes that shape unwritable.
//
// Only the folder and task glyphs are banned: they name a kind wherever
// they appear. `FileIcon`/`FileTextIcon`/`MailIcon`/`LinkIcon` carry
// ordinary non-entity meanings all over the app (empty states, uploads,
// mailto buttons, hyperlinks), so policing them would be noise. The
// `entity-kind-glyph-adhoc` ratchet metric covers whatever the ban cannot.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getImportedName } from "./utils.ts";

const LUCIDE_MODULE = "lucide-react";

// lucide exports both the plain and `Icon`-suffixed alias of every glyph.
const BANNED_IMPORTS = new Set([
  "Folder",
  "FolderIcon",
  "FolderOpen",
  "FolderOpenIcon",
  "ListTodo",
  "ListTodoIcon",
]);

const ALLOWED_FILES = [
  // The component that owns the mapping.
  "apps/web/src/components/workspaces/entity-kind-icon.tsx",
];

const filenameForContext = (context) =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

export default eslintCompatPlugin({
  meta: { name: "no-direct-entity-glyph" },
  rules: {
    "no-direct-entity-glyph": {
      meta: {
        type: "problem",
        messages: {
          directEntityGlyph:
            "Do not import '{{name}}' from 'lucide-react' here. Render " +
            '<EntityKindIcon kind="folder" | "task"> from ' +
            "'@/components/workspaces/entity-kind-icon' instead (pass " +
            'folderState="expanded" for an open folder), so every entity ' +
            "glyph comes from one exhaustive kind mapping. Use <EntityIcon> " +
            "when the entity is still resolving.",
        },
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return !ALLOWED_FILES.some((allowed) => filename.endsWith(allowed));
          },
          ImportDeclaration(node) {
            if (node.source.value !== LUCIDE_MODULE) {
              return;
            }
            if (!Array.isArray(node.specifiers)) {
              return;
            }
            for (const specifier of node.specifiers) {
              const name = getImportedName(specifier);
              if (name !== null && BANNED_IMPORTS.has(name)) {
                context.report({
                  node: specifier,
                  messageId: "directEntityGlyph",
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
