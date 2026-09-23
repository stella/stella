// Base UI's Field parts read `FieldRootContext`, which only `Field` provides
// (packages/ui/src/components/field.tsx). A part mounted without that root
// throws while rendering — "FieldRootContext is missing. Field parts must be
// placed within <Field.Root>" — and the throw takes down the whole route, not
// just the control. `FieldControl` is the one part that reads the context
// optionally: it renders with nothing to bind to rather than throwing, and
// carries its own message here.
//
// Flagged: a part in plain markup, with no `Field` above it.
//   <section className="grid">
//     <Input />
//     <FieldDescription>{hint}</FieldDescription>
//   </section>
// Allowed:
//   the same part under a `Field` ancestor, a part under a component declared
//   in this file that renders a `Field` of its own, and a part in a
//   component's markup that this file mounts inside a `Field`.
//
// Detection is single-file, which is the honest limit of a syntax rule here.
// The lexical walk covers a part's own markup; when that markup belongs to a
// component, the question moves to where this file mounts that component. It
// stops there. A part held in a variable or handed to a prop, a part under a
// wrapper component from another module (a `FieldRow` returning
// `<Field>{children}</Field>`), and a part in a component this file only
// exports all go unreported, because resolving them means following an import.
// False negatives are the deliberate trade; a part whose ancestors are all
// host elements is the shape that reaches production.
//
// `Field` and its parts resolve through the `@stll/ui/field` import, or a
// relative `./field` inside `packages/ui`, so the primitives' own module,
// which composes Base UI directly, is out of scope.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  elementName,
  everyNode,
  getImportLocalName,
  getImportedName,
  isAstNode,
} from "./utils.ts";

const FIELD_MODULE = "@stll/ui/field";
const ROOT_IMPORT = "Field";
// Parts that demand the root context (`useFieldRootContext(false)`) and throw
// without it.
const THROWING_PARTS = new Set([
  "FieldDescription",
  "FieldError",
  "FieldItem",
  "FieldLabel",
  "FieldValidity",
]);
// `FieldControl` reads the context optionally, so it renders unwired instead
// of throwing: no name, no validation, no validity state.
const UNWIRED_PARTS = new Set(["FieldControl"]);

// `packages/ui` reaches its own primitives relatively; every other workspace
// goes through the package specifier.
const isFieldModule = (source: string): boolean =>
  source === FIELD_MODULE ||
  (source.startsWith(".") && source.replace(/\.tsx?$/u, "").endsWith("/field"));

// JSX resolves a capitalised name to a component and a lowercase one to a host
// element, which is how markup this file owns is told from a component whose
// body lives elsewhere.
const COMPONENT_NAME = /^[A-Z]/u;

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

// The name a component is declared under: `function Row()` and
// `const Row = () => …` both name `Row`, while a callback names nothing.
const declaredComponentName = (node: AstNode): string | null => {
  if (node.type === "FunctionDeclaration") {
    return isAstNode(node.id) && typeof node.id.name === "string"
      ? node.id.name
      : null;
  }
  if (!FUNCTION_TYPES.has(node.type)) {
    return null;
  }
  const parent = isAstNode(node.parent) ? node.parent : null;
  return parent?.type === "VariableDeclarator" &&
    isAstNode(parent.id) &&
    parent.id.type === "Identifier" &&
    typeof parent.id.name === "string"
    ? parent.id.name
    : null;
};

export default eslintCompatPlugin({
  meta: { name: "field-parts-inside-field" },
  rules: {
    "field-parts-inside-field": {
      meta: {
        type: "problem",
        messages: {
          partOutsideField:
            '{{part}} renders outside Field. Base UI throws "FieldRootContext is missing. Field parts must be placed within <Field.Root>" while rendering a part with no Field ancestor, taking the route down with it. Wrap it in Field, or use a plain element for standalone text.',
          unwiredPartOutsideField:
            "{{part}} renders outside Field. With no Field ancestor it binds to nothing: no field name, no validation, no validity state. Wrap it in Field, or use the plain control on its own.",
        },
      },
      createOnce(context) {
        const rootLocals = new Set<string>();
        // Every imported part, mapped to what its missing root costs.
        const partLocals = new Map<
          string,
          "partOutsideField" | "unwiredPartOutsideField"
        >();
        // Components declared in this file. A name missing from this set
        // belongs to another module and cannot be read from here.
        const localComponents = new Set<string>();
        // Local components that render a `Field` somewhere in their body, so
        // one standing between a part and the markup may well be its root.
        const localFieldWrappers = new Set<string>();
        // Where this file mounts its own components, which is where a part in
        // their markup is decided.
        const localMountSites = new Map<string, AstNode[]>();

        const collectImports = (program: AstNode) => {
          rootLocals.clear();
          partLocals.clear();
          if (!Array.isArray(program.body)) {
            return;
          }
          for (const statement of program.body) {
            if (
              !isAstNode(statement) ||
              statement.type !== "ImportDeclaration" ||
              !isAstNode(statement.source) ||
              typeof statement.source.value !== "string" ||
              !isFieldModule(statement.source.value) ||
              !Array.isArray(statement.specifiers)
            ) {
              continue;
            }
            for (const specifier of statement.specifiers) {
              const imported = getImportedName(specifier);
              const local = getImportLocalName(specifier);
              if (imported === null || local === null) {
                continue;
              }
              if (imported === ROOT_IMPORT) {
                rootLocals.add(local);
              }
              if (THROWING_PARTS.has(imported)) {
                partLocals.set(local, "partOutsideField");
              }
              if (UNWIRED_PARTS.has(imported)) {
                partLocals.set(local, "unwiredPartOutsideField");
              }
            }
          }
        };

        const collectLocalComponents = (program: AstNode) => {
          const nodes = everyNode(program);
          for (const node of nodes) {
            const name = declaredComponentName(node);
            if (name === null || !COMPONENT_NAME.test(name)) {
              continue;
            }
            localComponents.add(name);
            const rendersField = everyNode(node).some((current) => {
              const rendered = elementName(current);
              return rendered !== null && rootLocals.has(rendered);
            });
            if (rendersField) {
              localFieldWrappers.add(name);
            }
          }
          for (const node of nodes) {
            const name = elementName(node);
            if (name === null || !localComponents.has(name)) {
              continue;
            }
            const sites = localMountSites.get(name);
            if (sites === undefined) {
              localMountSites.set(name, [node]);
            } else {
              sites.push(node);
            }
          }
        };

        // The component whose markup holds this element, skipping the
        // anonymous callbacks a list or a render prop introduces.
        const owningComponent = (node: AstNode): string | null => {
          let current = isAstNode(node.parent) ? node.parent : null;
          while (current !== null) {
            if (FUNCTION_TYPES.has(current.type)) {
              const name = declaredComponentName(current);
              if (name !== null && COMPONENT_NAME.test(name)) {
                return name;
              }
            }
            current = isAstNode(current.parent) ? current.parent : null;
          }
          return null;
        };

        // True when a `Field` covers this element, or when nothing readable in
        // this file rules one out. The lexical walk ends at the first
        // component ancestor from another module and at a local component that
        // renders a `Field`, because either may be the root. An element with
        // no JSX element above it is held in a variable or a prop, so its
        // mounting is decided elsewhere. Otherwise the element is the owning
        // component's own markup, and the question moves to where this file
        // mounts that component; a component this file never mounts is
        // rendered by another module and answers for itself.
        const isCoveredByField = (
          node: unknown,
          visited: Set<string>,
        ): boolean => {
          if (!isAstNode(node)) {
            return true;
          }
          let current = isAstNode(node.parent) ? node.parent : null;
          let mounted = false;
          while (current !== null) {
            const name = elementName(current);
            if (name !== null) {
              mounted = true;
              if (
                COMPONENT_NAME.test(name) &&
                (rootLocals.has(name) ||
                  !localComponents.has(name) ||
                  localFieldWrappers.has(name))
              ) {
                return true;
              }
            }
            current = isAstNode(current.parent) ? current.parent : null;
          }
          if (!mounted) {
            return true;
          }
          const owner = owningComponent(node);
          if (owner === null || visited.has(owner)) {
            return true;
          }
          visited.add(owner);
          const sites = localMountSites.get(owner);
          return sites === undefined
            ? false
            : sites.some((site) => isCoveredByField(site, visited));
        };

        return {
          Program(program) {
            if (!isAstNode(program)) {
              return;
            }
            collectImports(program);
            localComponents.clear();
            localFieldWrappers.clear();
            localMountSites.clear();
            // Most files import no part at all; walking them twice buys
            // nothing.
            if (partLocals.size > 0) {
              collectLocalComponents(program);
            }
          },
          JSXElement(node) {
            const name = elementName(node);
            if (name === null) {
              return;
            }
            const messageId = partLocals.get(name);
            if (messageId === undefined) {
              return;
            }
            if (isCoveredByField(node, new Set())) {
              return;
            }
            context.report({ node, messageId, data: { part: name } });
          },
        };
      },
    },
  },
});
