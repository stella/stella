import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";
import {
  containsJsxTag,
  sourceFileIndex,
} from "@stll/scripts/src/source-file-index";
import {
  type Node,
  type ParsedSource,
  walk as walkSyntax,
} from "@stll/scripts/src/syntax-tree";

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
  node: Node;
  source: ParsedSource;
  tags: Set<string>;
  dialogChildren: Set<string>;
  imports: Map<string, { file: string; name: string }>;
  hasDirtySignal: boolean;
};

const jsxTags = (node: Node, source: ParsedSource): Set<string> => {
  const tags = new Set<string>();
  const visit = (current: Node) => {
    if (current.type === "JSXOpeningElement") {
      tags.add(source.sourceText.slice(current.name.start, current.name.end));
    }
  };
  walkSyntax(node, visit);
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
  const dialogHosts: Node[] = [];
  for (const entry of [
    ...sourceFileIndex(SOURCE_ROOT),
    ...sourceFileIndex(DESKTOP_SOURCE_ROOT),
  ].filter(
    ({ relativePath, sourceText }) =>
      relativePath.endsWith(".tsx") &&
      !/\.(test|spec)\.tsx$/u.test(relativePath) &&
      containsJsxTag(sourceText),
  )) {
    const file = entry.filePath;
    const sourceRoot = file.startsWith(DESKTOP_SOURCE_ROOT)
      ? DESKTOP_SOURCE_ROOT
      : SOURCE_ROOT;
    const source = entry.sourceFile();
    const imports = new Map<string, { file: string; name: string }>();
    for (const statement of source.program.body) {
      if (statement.type !== "ImportDeclaration") {
        continue;
      }
      const specifier = statement.source.value;
      let resolved = specifier;
      if (!specifier.startsWith("@stll/ui/")) {
        if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
          continue;
        }
        const stem = specifier.startsWith("@/")
          ? path.join(sourceRoot, specifier.slice(2))
          : path.resolve(path.dirname(file), specifier);
        const filename = [stem, `${stem}.tsx`, `${stem}.ts`].find((candidate) =>
          existsSync(candidate),
        );
        if (!filename) {
          continue;
        }
        resolved = filename;
      }
      for (const binding of statement.specifiers) {
        if (binding.type === "ImportSpecifier") {
          imports.set(binding.local.name, {
            file: resolved,
            name:
              binding.imported.type === "Identifier"
                ? binding.imported.name
                : binding.imported.value,
          });
        }
        if (
          binding.type === "ImportDefaultSpecifier" &&
          !specifier.startsWith("@stll/ui/")
        ) {
          imports.set(binding.local.name, { file: resolved, name: "default" });
        }
      }
    }
    const add = (name: string, node: Node) => {
      const dialogChildren = new Set<string>();
      let hasDirtySignal = false;
      const visit = (current: Node) => {
        if (current.type === "JSXOpeningElement") {
          const primitive = imports.get(
            source.sourceText.slice(current.name.start, current.name.end),
          );
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
            current.attributes.some(
              (attribute) =>
                attribute.type === "JSXAttribute" &&
                source.sourceText.slice(
                  attribute.name.start,
                  attribute.name.end,
                ) === "dirty",
            )
          ) {
            hasDirtySignal = true;
          }
        }
        const root =
          current.type === "JSXElement"
            ? imports.get(
                source.sourceText.slice(
                  current.openingElement.name.start,
                  current.openingElement.name.end,
                ),
              )
            : undefined;
        if (
          current.type === "JSXElement" &&
          !current.openingElement.selfClosing &&
          root?.file === "@stll/ui/dialog" &&
          root.name === "Dialog"
        ) {
          dialogHosts.push(current);
          for (const tag of jsxTags(current, source)) {
            dialogChildren.add(tag);
          }
        }
      };
      walkSyntax(node, visit);
      const key = `${sourceRoot === DESKTOP_SOURCE_ROOT ? "desktop/" : ""}${repoRelativePath(sourceRoot, file)}#${name}`;
      components.set(`${file}#${name}`, {
        key,
        file,
        node,
        source,
        imports,
        tags: jsxTags(node, source),
        dialogChildren,
        hasDirtySignal,
      });
    };
    for (const exported of source.program.body) {
      const statement =
        exported.type === "ExportNamedDeclaration" ||
        exported.type === "ExportDefaultDeclaration"
          ? exported.declaration
          : exported;
      if (statement?.type === "VariableDeclaration") {
        for (const declaration of statement.declarations) {
          if (
            declaration.id.type === "Identifier" &&
            declaration.init &&
            (declaration.init.type === "ArrowFunctionExpression" ||
              declaration.init.type === "FunctionExpression")
          ) {
            add(declaration.id.name, declaration.init);
          }
        }
      }
      if (statement?.type === "FunctionDeclaration" && statement.id) {
        add(statement.id.name, statement);
      }
      if (
        exported.type === "ExportDefaultDeclaration" &&
        exported.declaration.type === "Identifier"
      ) {
        const existing = components.get(`${file}#${exported.declaration.name}`);
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
      const visit = (node: Node) => {
        if (
          node.type === "JSXOpeningElement" &&
          node.attributes.some(
            (attribute) =>
              attribute.type === "JSXAttribute" &&
              component.source.sourceText.slice(
                attribute.name.start,
                attribute.name.end,
              ) === "dirty",
          )
        ) {
          const target = resolve(
            component,
            component.source.sourceText.slice(node.name.start, node.name.end),
          );
          if (target?.hasDirtySignal) {
            component.hasDirtySignal = true;
            propagation.changed = true;
          }
        }
      };
      walkSyntax(component.node, visit);
    }
  }
  const owners = new Map<string, Component>();
  const visited = new Set<string>();
  const walk = (component: Component, tags: Set<string>) => {
    const source = component.source.sourceText.slice(
      component.node.start,
      component.node.end,
    );
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
    const visit = (node: Node) => {
      if (node.type === "JSXElement" && !node.openingElement.selfClosing) {
        const target = resolve(
          component,
          component.source.sourceText.slice(
            node.openingElement.name.start,
            node.openingElement.name.end,
          ),
        );
        if (target && target.dialogChildren.size > 0) {
          const children = new Set<string>();
          for (const child of node.children) {
            for (const tag of jsxTags(child, component.source)) {
              children.add(tag);
            }
          }
          if (children.size > 0) {
            walk(component, children);
          }
        }
      }
    };
    walkSyntax(component.node, visit);
  }
  return {
    owners,
    hostCount: dialogHosts.length,
    componentKeys: new Set([...components.values()].map(({ key }) => key)),
  };
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
  const { owners, hostCount, componentKeys } = inventory();
  expect(hostCount).toBeGreaterThan(0);
  expect(owners.size).toBeGreaterThan(0);
  expect(
    componentKeys.has(
      "__fixtures__/inventory-prefilter/identifier-starts.tsx#UnicodeAliases",
    ),
  ).toBe(true);
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
