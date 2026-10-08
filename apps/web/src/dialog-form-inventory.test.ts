import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const SOURCE_ROOT = import.meta.dirname;
const DESKTOP_SOURCE_ROOT = path.resolve(SOURCE_ROOT, "../../desktop/src");
const EDITABLE_CONTROLS = new Set([
  "Input",
  "Textarea",
  "Select",
  "InputOTP",
  "Checkbox",
  "FileInput",
  "ConditionBuilder",
  "HybridMarkdownEditor",
  "PropertyPromptInput",
]);

type Component = {
  key: string;
  file: string;
  node: ts.Node;
  tags: Set<string>;
  dialogChildren: Set<string>;
  imports: Map<string, { file: string; name: string }>;
  hasDirtySignal: boolean;
};

const sourcePaths = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourcePaths(filename));
      continue;
    }
    if (
      /\.tsx?$/u.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/u.test(entry.name)
    ) {
      files.push(filename);
    }
  }
  return files;
};

const jsxTags = (node: ts.Node): Set<string> => {
  const tags = new Set<string>();
  const visit = (current: ts.Node) => {
    if (
      ts.isJsxOpeningElement(current) ||
      ts.isJsxSelfClosingElement(current)
    ) {
      tags.add(current.tagName.getText());
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return tags;
};

const isSharedForm = (component: Component, tag: string) => {
  const primitive = component.imports.get(tag);
  return primitive?.file === "@stll/ui/form" && primitive.name === "Form";
};

const isEditableControl = (component: Component, tag: string) => {
  const primitive = component.imports.get(tag);
  return EDITABLE_CONTROLS.has(primitive?.name ?? tag);
};

const inventory = () => {
  const components = new Map<string, Component>();
  const dialogHosts: ts.Node[] = [];
  for (const file of [
    ...sourcePaths(SOURCE_ROOT),
    ...sourcePaths(DESKTOP_SOURCE_ROOT),
  ]) {
    const sourceRoot = file.startsWith(DESKTOP_SOURCE_ROOT)
      ? DESKTOP_SOURCE_ROOT
      : SOURCE_ROOT;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const imports = new Map<string, { file: string; name: string }>();
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (specifier.startsWith("@stll/ui/")) {
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            imports.set(binding.name.text, {
              file: specifier,
              name: binding.propertyName?.text ?? binding.name.text,
            });
          }
        }
        continue;
      }
      if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
        continue;
      }
      const stem = specifier.startsWith("@/")
        ? path.join(sourceRoot, specifier.slice(2))
        : path.resolve(path.dirname(file), specifier);
      const resolved = [stem, `${stem}.tsx`, `${stem}.ts`].find((filename) =>
        existsSync(filename),
      );
      if (!resolved) {
        continue;
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          imports.set(binding.name.text, {
            file: resolved,
            name: binding.propertyName?.text ?? binding.name.text,
          });
        }
      }
      if (statement.importClause?.name) {
        imports.set(statement.importClause.name.text, {
          file: resolved,
          name: "default",
        });
      }
    }
    const add = (name: string, node: ts.Node) => {
      const dialogChildren = new Set<string>();
      let hasDirtySignal = false;
      const visit = (current: ts.Node) => {
        if (
          ts.isJsxOpeningElement(current) ||
          ts.isJsxSelfClosingElement(current)
        ) {
          const primitive = imports.get(current.tagName.getText());
          if (
            primitive?.file === "@stll/ui/dialog" &&
            primitive.name === "DialogFormState"
          ) {
            hasDirtySignal = true;
          }
          if (
            ((primitive?.file === "@stll/ui/form" &&
              primitive.name === "Form") ||
              (primitive?.file === "@stll/ui/dialog" &&
                primitive.name === "Dialog")) &&
            current.attributes.properties.some(
              (attribute) =>
                ts.isJsxAttribute(attribute) &&
                attribute.name.getText() === "dirty",
            )
          ) {
            hasDirtySignal = true;
          }
        }
        const root = ts.isJsxElement(current)
          ? imports.get(current.openingElement.tagName.getText())
          : undefined;
        if (
          ts.isJsxElement(current) &&
          root?.file === "@stll/ui/dialog" &&
          root.name === "Dialog"
        ) {
          dialogHosts.push(current);
          for (const tag of jsxTags(current)) {
            dialogChildren.add(tag);
          }
        }
        ts.forEachChild(current, visit);
      };
      visit(node);
      const key = `${sourceRoot === DESKTOP_SOURCE_ROOT ? "desktop/" : ""}${path.relative(sourceRoot, file)}#${name}`;
      components.set(`${file}#${name}`, {
        key,
        file,
        node,
        imports,
        tags: jsxTags(node),
        dialogChildren,
        hasDirtySignal,
      });
    };
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer))
          ) {
            add(declaration.name.text, declaration.initializer);
          }
        }
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        add(statement.name.text, statement);
      }
      if (
        ts.isExportAssignment(statement) &&
        ts.isIdentifier(statement.expression)
      ) {
        const existing = components.get(`${file}#${statement.expression.text}`);
        if (existing) {
          components.set(`${file}#default`, existing);
        }
      }
    }
  }
  const resolve = (component: Component, tag: string) => {
    const local = components.get(`${component.file}#${tag}`);
    if (local) {
      return local;
    }
    const imported = component.imports.get(tag);
    return imported
      ? components.get(`${imported.file}#${imported.name}`)
      : undefined;
  };
  // A shared custom form may register the signal passed by its owning body.
  // Derive this delegation to a fixed point so adapters remain covered.
  const propagation = { changed: true };
  while (propagation.changed) {
    propagation.changed = false;
    for (const component of components.values()) {
      if (component.hasDirtySignal) {
        continue;
      }
      const visit = (node: ts.Node) => {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.attributes.properties.some(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText() === "dirty",
          )
        ) {
          const target = resolve(component, node.tagName.getText());
          if (target?.hasDirtySignal) {
            component.hasDirtySignal = true;
            propagation.changed = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(component.node);
    }
  }
  const owners = new Map<string, Component>();
  const visited = new Set<string>();
  const walk = (component: Component, tags: Set<string>) => {
    const source = component.node.getText();
    const hasForm =
      component.hasDirtySignal ||
      tags.has("form") ||
      [...tags].some((tag) => isSharedForm(component, tag)) ||
      ([...tags].some((tag) => isEditableControl(component, tag)) &&
        /\buse(?:State|Reducer|Form)\s*[<(]/u.test(source));
    if (hasForm) {
      owners.set(component.key, component);
    }
    for (const tag of tags) {
      const next = resolve(component, tag);
      if (!next || visited.has(next.key)) {
        continue;
      }
      visited.add(next.key);
      walk(next, next.tags);
    }
  };
  for (const component of components.values()) {
    if (component.dialogChildren.size > 0) {
      walk(component, component.dialogChildren);
    }
  }
  // A reusable dialog shell receives its form as JSX children at its caller.
  for (const component of components.values()) {
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node)) {
        const target = resolve(
          component,
          node.openingElement.tagName.getText(),
        );
        if (target && target.dialogChildren.size > 0) {
          const children = new Set<string>();
          for (const child of node.children) {
            for (const tag of jsxTags(child)) {
              children.add(tag);
            }
          }
          if (children.size > 0) {
            walk(component, children);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(component.node);
  }
  return { owners, hostCount: dialogHosts.length };
};

// These editors save immediately or only choose/search; closing loses no draft.
const NON_DRAFT_OWNERS = new Map<
  string,
  { type: "autosaved" | "search" | "parent-owned"; reason: string }
>([
  [
    "components/matter-target-picker.tsx#MatterTargetPicker",
    {
      type: "search",
      reason:
        "Matter text filters results; selected/staged targets belong to the enclosing form.",
    },
  ],
  [
    "components/billing/time-entry-narrative-field.tsx#TimeEntryNarrativeField",
    {
      type: "parent-owned",
      reason:
        "Narrative and language changes go to the registered time-entry form.",
    },
  ],
  [
    "components/workspaces/bulk-add-columns.tsx#DraftCard",
    {
      type: "parent-owned",
      reason: "Draft card changes go to the registered column body.",
    },
  ],
  [
    "components/workspaces/properties/property-conditions.tsx#DependencyConditionEditor",
    {
      type: "autosaved",
      reason:
        "Every condition change persists immediately into the enclosing property draft.",
    },
  ],
  [
    "components/docx/evidence-references.tsx#EvidenceFilePicker",
    {
      type: "search",
      reason:
        "Search filters evidence files; choosing inserts the evidence immediately.",
    },
  ],
  [
    "routes/_protected.contacts/-components/person-details-fields.tsx#PersonDetailsFields",
    {
      type: "parent-owned",
      reason:
        "Birth date and nationality changes go to the registered contact form.",
    },
  ],
  [
    "components/templates/template-prefill-panel.tsx#TemplatePrefillPanel",
    {
      type: "parent-owned",
      reason:
        "Prefill applies directly to the registered template form values.",
    },
  ],
  [
    "components/templates/template-form.tsx#RegistryAutofillControl",
    {
      type: "search",
      reason:
        "Registry input searches an external registry; choosing a result fills parent values.",
    },
  ],
  [
    "routes/dev/-components/ui-playground.tsx#UiPlayground",
    {
      type: "search",
      reason:
        "Development-only primitive previews do not create or edit persisted data.",
    },
  ],
  [
    "routes/_protected.workspaces/$workspaceId/-components/new-document-from-template-dialog.tsx#TemplatePickList",
    {
      type: "search",
      reason:
        "Search filters available templates; the fill step owns the draft.",
    },
  ],
  [
    "routes/_protected.workspaces/$workspaceId/-components/existing-file-organizer-dialog.tsx#InlineNameInput",
    {
      type: "parent-owned",
      reason: "Name edits update the registered organizer rows on commit.",
    },
  ],
  [
    "components/workspaces/editable-field.tsx#InlineIntEditor",
    {
      type: "autosaved",
      reason: "This field persists each committed inline value immediately.",
    },
  ],
  [
    "routes/_protected.workspaces/$workspaceId/-components/billing/billing-codes-dialog.tsx#BillingCodesDialog",
    {
      type: "parent-owned",
      reason:
        "The visible CreateCodeForm owns and registers the new code values.",
    },
  ],
]);

test("every form reachable from a shared dialog provides semantic dirtiness and discard", () => {
  const { owners, hostCount } = inventory();
  expect(hostCount).toBeGreaterThan(0);
  expect(owners.size).toBeGreaterThan(0);
  const uncovered: string[] = [];
  for (const [key, component] of owners) {
    if (NON_DRAFT_OWNERS.has(key)) {
      continue;
    }
    if (!component.hasDirtySignal) {
      uncovered.push(key);
    }
  }
  expect(uncovered).toEqual([]);
  for (const [key, disposition] of NON_DRAFT_OWNERS) {
    expect(owners.has(key)).toBe(true);
    expect(disposition.reason.length).toBeGreaterThan(0);
  }
});
