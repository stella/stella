// Product code renders `@stll/ui`, not the native markup a design-system
// component already wraps. A hand-rolled `<button role="switch">` ships
// without the component's focus ring, disabled state, right-to-left thumb
// travel and data attributes, and drifts from every other switch the moment
// either one changes.
//
// One rule per component, generated from ./no-native-ui-registry.ts:
// `no-native-ui/no-native-<module>`. Each reads the patterns its registry row
// lists and names the import to use instead:
//
//   elements     <hr />, <select>, <details>, ...            (intrinsic tags)
//   roles        role="switch", role={open ? "dialog" : x}   (any element)
//   inputTypes   <input type="checkbox" />, <Input type="number" />
//   attributes   <div popover />, <span title="..." />       (intrinsic only)
//
// `no-native-input` reports every `<input>` whose type no other rule owns, so
// one native control is reported once: a checkbox by the checkbox rule, a
// date by no-raw-date-input, a text field by the input rule.
//
// The registry's React Native column adds the components a native renderer
// replaces in the app: `<Pressable>` imported from "react-native" (under any
// local name, or as `RN.Pressable`) is the button rule's, `<ActivityIndicator>`
// the loader rule's, a `<TextInput multiline>` the textarea rule's. `role` and
// React Native's `accessibilityRole` are read alike.
//
// The design system itself renders this markup and is out of scope
// (oxlint.config.ts); so is a role a component sets for its own popup, which
// never appears at a product call site.

import type { CreateOnceRule } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  INPUT_TYPES_OUTSIDE_INPUT_RULE,
  type NativeAttribute,
  nativeEntries,
  type NativeRuleEntry,
  REACT_NATIVE_MODULE,
} from "./no-native-ui-registry.ts";
import { isAstNode, jsxName } from "./utils.ts";

/** Elements that forward `type` to a native `<input>`. */
const INPUT_ELEMENTS = new Set(["input", "Input"]);

// The string literals an expression can evaluate to: a bare literal, a
// template without substitutions, and both branches of a ternary (recursing
// for nested ones). Runtime-computed values are left alone.
const literalStringsOf = (expression: unknown): string[] => {
  if (!isAstNode(expression)) {
    return [];
  }
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return [expression.value];
  }
  if (
    expression.type === "TemplateLiteral" &&
    Array.isArray(expression.expressions) &&
    expression.expressions.length === 0 &&
    Array.isArray(expression.quasis)
  ) {
    const [quasi]: unknown[] = expression.quasis;
    const cooked =
      isAstNode(quasi) &&
      typeof quasi.value === "object" &&
      quasi.value !== null &&
      "cooked" in quasi.value
        ? quasi.value.cooked
        : null;
    return typeof cooked === "string" ? [cooked] : [];
  }
  if (expression.type === "ConditionalExpression") {
    return [
      ...literalStringsOf(expression.consequent),
      ...literalStringsOf(expression.alternate),
    ];
  }
  if (expression.type === "JSXExpressionContainer") {
    return literalStringsOf(expression.expression);
  }
  return [];
};

type JsxAttributeShape = { name: string; value: unknown; node: unknown };

const attributesOf = (opening: unknown): JsxAttributeShape[] => {
  if (!isAstNode(opening) || !Array.isArray(opening.attributes)) {
    return [];
  }
  return opening.attributes.flatMap((attribute: unknown) => {
    if (!isAstNode(attribute) || attribute.type !== "JSXAttribute") {
      return [];
    }
    const name = jsxName(attribute.name);
    return name === null
      ? []
      : [{ name, value: attribute.value, node: attribute }];
  });
};

const isIntrinsic = (name: string): boolean => /^[a-z]/u.test(name);

/** Every `type` an `<input>` can render with; "text" when it names none. */
const inputTypesOf = (opening: unknown): string[] | "dynamic" => {
  const type = attributesOf(opening).find(({ name }) => name === "type");
  if (type === undefined) {
    return ["text"];
  }
  const values = literalStringsOf(type.value);
  return values.length === 0 ? "dynamic" : values.map((v) => v.toLowerCase());
};

const attributeMatches = (
  pattern: NativeAttribute,
  element: string,
  attribute: JsxAttributeShape,
): boolean => {
  if (
    attribute.name.toLowerCase() !== pattern.name.toLowerCase() ||
    pattern.exceptOn?.includes(element) === true
  ) {
    return false;
  }
  if (pattern.values === undefined) {
    return true;
  }
  const values = literalStringsOf(attribute.value).map((v) => v.toLowerCase());
  return pattern.values.some((wanted) => values.includes(wanted));
};

/** Input types some generated rule other than the input rule claims. */
const CLAIMED_INPUT_TYPES = new Set(
  nativeEntries().flatMap(({ patterns }) => patterns.inputTypes ?? []),
);

const isInputRuleType = (type: string): boolean =>
  !CLAIMED_INPUT_TYPES.has(type) &&
  !Object.hasOwn(INPUT_TYPES_OUTSIDE_INPUT_RULE, type);

/** The attributes that carry an element's role, on the web and in React Native. */
const ROLE_ATTRIBUTES = new Set(["role", "accessibilityRole"]);

/**
 * What a file imports from "react-native": local name to imported name, and
 * the namespaces (`import * as RN`) that reach every component.
 */
type ReactNativeImports = {
  readonly named: Map<string, string>;
  readonly namespaces: Set<string>;
};

const importedName = (specifier: unknown): string | null => {
  if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
    return null;
  }
  const imported: unknown = specifier.imported;
  if (!isAstNode(imported)) {
    return null;
  }
  if (imported.type === "Identifier" && typeof imported.name === "string") {
    return imported.name;
  }
  return typeof imported.value === "string" ? imported.value : null;
};

const localName = (specifier: unknown): string | null => {
  if (!isAstNode(specifier) || !isAstNode(specifier.local)) {
    return null;
  }
  return typeof specifier.local.name === "string" ? specifier.local.name : null;
};

const recordReactNativeImports = (
  declaration: unknown,
  imports: ReactNativeImports,
): void => {
  if (
    !isAstNode(declaration) ||
    !isAstNode(declaration.source) ||
    declaration.source.value !== REACT_NATIVE_MODULE ||
    declaration.importKind === "type" ||
    !Array.isArray(declaration.specifiers)
  ) {
    return;
  }
  for (const specifier of declaration.specifiers) {
    const local = localName(specifier);
    if (local === null || !isAstNode(specifier)) {
      continue;
    }
    if (specifier.type === "ImportNamespaceSpecifier") {
      imports.namespaces.add(local);
      continue;
    }
    const imported = importedName(specifier);
    if (imported !== null && specifier.importKind !== "type") {
      imports.named.set(local, imported);
    }
  }
};

/** The React Native component a JSX tag renders, or null for any other tag. */
const reactNativeComponent = (
  name: unknown,
  imports: ReactNativeImports,
): string | null => {
  if (!isAstNode(name)) {
    return null;
  }
  if (name.type === "JSXIdentifier" && typeof name.name === "string") {
    return imports.named.get(name.name) ?? null;
  }
  if (
    name.type === "JSXMemberExpression" &&
    isAstNode(name.object) &&
    name.object.type === "JSXIdentifier" &&
    typeof name.object.name === "string" &&
    imports.namespaces.has(name.object.name)
  ) {
    return jsxName(name.property);
  }
  return null;
};

/** Whether an element sets a flag attribute (`multiline`, not `={false}`). */
const setsFlag = (opening: unknown, flag: string): boolean =>
  attributesOf(opening).some(
    ({ name, value }) =>
      name === flag &&
      !(
        isAstNode(value) &&
        value.type === "JSXExpressionContainer" &&
        isAstNode(value.expression) &&
        value.expression.type === "Literal" &&
        value.expression.value === false
      ),
  );

/** `TextInput[multiline]`: a component, and the flag that picks this rule. */
const parseSelector = (
  selector: string,
): { component: string; flag: string | null } => {
  const match = /^(?<component>\w+)(?:\[(?<flag>\w+)\])?$/u.exec(selector);
  return {
    component: match?.groups?.["component"] ?? selector,
    flag: match?.groups?.["flag"] ?? null,
  };
};

/** Flags some rule's selector picks out of each React Native component. */
const FLAGGED_SELECTORS = new Map<string, string[]>();
for (const { reactNative } of nativeEntries()) {
  for (const { component, flag } of reactNative.map(parseSelector)) {
    if (flag !== null) {
      FLAGGED_SELECTORS.set(component, [
        ...(FLAGGED_SELECTORS.get(component) ?? []),
        flag,
      ]);
    }
  }
}

/** Whether one React Native element is what `selector` names. */
const selectorMatches = (
  selector: string,
  component: string,
  opening: unknown,
): boolean => {
  const parsed = parseSelector(selector);
  if (parsed.component !== component) {
    return false;
  }
  if (parsed.flag !== null) {
    return setsFlag(opening, parsed.flag);
  }
  return !(FLAGGED_SELECTORS.get(component) ?? []).some((flag) =>
    setsFlag(opening, flag),
  );
};

const MESSAGE =
  "{{found}} hand-rolls a control @stll/ui already ships. Render {{use}} instead.";

// The rule a registry row generates. `docs.description` carries the row's
// replacement so the registry test can prove each rule name is wired to its
// own row.
const ENTRIES = new Map(nativeEntries().map((entry) => [entry.module, entry]));

const nativeRule = (module: string): CreateOnceRule => {
  const { use, patterns, reactNative }: NativeRuleEntry = ENTRIES.get(
    module,
  ) ?? { module, use: "", patterns: {}, reactNative: [] };
  return {
    meta: {
      type: "problem",
      docs: { description: use },
      messages: { native: MESSAGE },
      schema: [],
    },
    createOnce(context) {
      const report = (node: unknown, found: string) => {
        if (isAstNode(node)) {
          context.report({ node, messageId: "native", data: { found, use } });
        }
      };
      const imports: ReactNativeImports = {
        named: new Map(),
        namespaces: new Set(),
      };
      return {
        before() {
          imports.named.clear();
          imports.namespaces.clear();
          return true;
        },
        ImportDeclaration(node) {
          recordReactNativeImports(node, imports);
        },
        JSXOpeningElement(node) {
          if (!isAstNode(node)) {
            return;
          }
          const element = jsxName(node.name);
          if (element === null) {
            return;
          }
          const component = reactNativeComponent(node.name, imports);
          if (
            component !== null &&
            reactNative.some((selector) =>
              selectorMatches(selector, component, node),
            )
          ) {
            report(node, `React Native's <${component}>`);
          }
          const intrinsic = isIntrinsic(element);
          if (intrinsic && patterns.elements?.includes(element) === true) {
            if (element !== "input") {
              report(node, `<${element}>`);
            } else {
              const types = inputTypesOf(node);
              if (types === "dynamic" || types.some(isInputRuleType)) {
                report(node, "<input>");
              }
            }
          }
          for (const attribute of attributesOf(node)) {
            if (ROLE_ATTRIBUTES.has(attribute.name)) {
              const role = literalStringsOf(attribute.value).find((value) =>
                patterns.roles?.includes(value),
              );
              if (role !== undefined) {
                report(attribute.node, `${attribute.name}="${role}"`);
              }
              continue;
            }
            if (attribute.name === "type" && INPUT_ELEMENTS.has(element)) {
              const type = literalStringsOf(attribute.value).find((value) =>
                patterns.inputTypes?.includes(value.toLowerCase()),
              );
              if (type !== undefined) {
                report(attribute.node, `<${element} type="${type}">`);
              }
              continue;
            }
            if (
              intrinsic &&
              patterns.attributes?.some((pattern) =>
                attributeMatches(pattern, element, attribute),
              ) === true
            ) {
              report(attribute.node, `The ${attribute.name} attribute`);
            }
          }
        },
      };
    },
  };
};

// One rule per registry row of kind "native", named `no-native-<module>`.
// .oxlint-plugins/__tests__/no-native-ui-registry.test.ts fails when this list
// and the registry disagree.
export default eslintCompatPlugin({
  meta: { name: "no-native-ui" },
  rules: {
    "no-native-accordion": nativeRule("accordion"),
    "no-native-alert-dialog": nativeRule("alert-dialog"),
    "no-native-button": nativeRule("button"),
    "no-native-checkbox": nativeRule("checkbox"),
    "no-native-color-picker": nativeRule("color-picker"),
    "no-native-combobox": nativeRule("combobox"),
    "no-native-details-grid": nativeRule("details-grid"),
    "no-native-dialog": nativeRule("dialog"),
    "no-native-form": nativeRule("form"),
    "no-native-input": nativeRule("input"),
    "no-native-input-otp": nativeRule("input-otp"),
    "no-native-loader": nativeRule("loader"),
    "no-native-label": nativeRule("label"),
    "no-native-menu": nativeRule("menu"),
    "no-native-number-input": nativeRule("number-input"),
    "no-native-popover": nativeRule("popover"),
    "no-native-secret-input": nativeRule("secret-input"),
    "no-native-select": nativeRule("select"),
    "no-native-separator": nativeRule("separator"),
    "no-native-sheet": nativeRule("sheet"),
    "no-native-switch": nativeRule("switch"),
    "no-native-table": nativeRule("table"),
    "no-native-tabs": nativeRule("tabs"),
    "no-native-text": nativeRule("text"),
    "no-native-textarea": nativeRule("textarea"),
    "no-native-tooltip": nativeRule("tooltip"),
  },
});
