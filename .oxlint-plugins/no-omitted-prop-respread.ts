import { eslintCompatPlugin } from "@oxlint/plugins";
// `Omit<Props, "k">` on a component does not keep `k` off the element.
//
// Omitting a key narrows what a caller may write *literally*. It does not
// narrow what a value can carry: TypeScript is width-subtyping, so a props
// object typed wider than the omitting component's parameter is still
// assignable to it, and the rest object collected from a spread keeps every
// runtime key the caller passed. `{...props}` in the body then re-applies `k`
// to the element the omit was meant to protect.
//
// JSX attribute order decides the winner. React builds the props object left
// to right, so an attribute written before the spread is overwritten by it,
// and an attribute the component never writes is supplied by it. Only an
// attribute to the right of the last spread survives. `Omit` therefore reads
// as a guarantee while the layout, variant, or direction it was protecting
// silently follows whatever reached the spread.
//
// Flagged, when a component's parameter type omits literal keys and the body
// spreads that parameter's binding into a JSX element:
//
//   const Tabs = ({ ...props }: Omit<TabsProps, "orientation">) => (
//     <Root orientation="horizontal" {...props} />   // spread wins
//   );
//   const Tabs = ({ ...props }: Omit<TabsProps, "orientation">) => (
//     <Root {...props} />                            // spread supplies it
//   );
//
// Allowed:
//
//   const Tabs = ({ ...props }: Omit<TabsProps, "orientation">) => (
//     <Root {...props} orientation="horizontal" />   // pinned after
//   );
//
// Two shapes are out of scope because the key is not actually removed:
//
//   - The pattern destructures the key (`({ size, ...props }: Omit<P, "size">)`).
//     A rest object provably excludes what the pattern named, so no spread of
//     it can carry the key.
//   - The props type re-declares the key alongside the omission
//     (`Omit<P, "size"> & { size?: Local }`). That is a re-typing, not a
//     prohibition, and the key is meant to reach the element.
//
// Analysis boundary. This is a tripwire for the common shape, not a proof:
//
//   - Only the component's own props binding counts as the smuggling spread —
//     an identifier or rest element annotated with the omitting type. A wider
//     value spread from anywhere else is invisible here.
//   - Omitted keys must be string literals in the `Omit<..., "a" | "b">`
//     position. A generic or computed key set (`Omit<P, K>`, `keyof Q`) is out
//     of scope, as is an `Omit` reached through an imported type alias; only
//     file-local type aliases and the modifier utilities `Partial`, `Readonly`,
//     and `Required` are unwrapped.
//   - `Omit` is matched by name. A shadowed or re-exported `Omit` is not
//     distinguished.
//   - The omission must be written on the parameter. A props type inferred from
//     a generic wrapper (`forwardRef<Ref, Omit<P, "k">>`) is not read.
//   - JSX children override a spread `children` prop, so an element with a
//     rendered child satisfies an omitted `children` key. Whitespace and a JSX
//     comment emit no child and do not count.
//   - A spread of an object literal can only deliver what the literal declares,
//     spreads in, or computes; anything else is opaque and assumed able to.
//   - The spread identifier is resolved through the lexical scope chain, so a
//     shadowing binding of the same name always wins over an enclosing one.
//
// When a key legitimately passes through by design, suppress the finding with
// `// eslint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread`
// and a reason. The rule is not in `TRACKED_SUPPRESSION_RULES`, so the
// directive is charged to the residual suppression budget in `scripts/ratchet.ts`:
// the exception is still countable and decrease-only, without claiming a tenancy,
// capacity, or diagnosability tier it does not guard. The repo carries none today.

import { getPropertyName, isIdentifier } from "./utils.ts";

const OMIT_TYPE = "Omit";

// Utility types that change property modifiers without changing which keys
// exist, so an omission underneath one still holds and a member declared
// underneath one is still a reintroduction.
const MODIFIER_UTILITIES = new Set(["Partial", "Readonly", "Required"]);

const typeArgumentsOf = (typeNode) =>
  typeNode?.typeArguments?.params ?? typeNode?.typeParameters?.params ?? [];

// The dotted name of a type reference: `Props`, `React.ComponentProps`.
const typeReferenceName = (typeName) => {
  if (isIdentifier(typeName)) {
    return typeName.name;
  }
  if (typeName?.type !== "TSQualifiedName") {
    return null;
  }
  const left = typeReferenceName(typeName.left);
  const right = getPropertyName(typeName.right);
  return left === null || right === null ? null : `${left}.${right}`;
};

// The body of a file-local alias, unless it is already being expanded on this
// path. `open` bounds cyclic aliases without capping how deep an honest chain
// may go: a depth cutoff would silently stop reporting past the limit.
const expandAlias = (name, localTypes, open) => {
  if (name === null || open.has(name)) {
    return null;
  }
  return localTypes.get(name) ?? null;
};

// String keys from the second `Omit` argument: `"a"` or `"a" | "b"`.
// A non-literal key set yields nothing, which is the documented boundary.
const literalKeysOf = (keyTypeNode): string[] => {
  if (keyTypeNode?.type === "TSLiteralType") {
    const literal = keyTypeNode.literal;
    return typeof literal?.value === "string" ? [literal.value] : [];
  }
  if (keyTypeNode?.type === "TSUnionType") {
    return keyTypeNode.types.flatMap(literalKeysOf);
  }
  return [];
};

/**
 * Literal keys omitted anywhere inside a type position, following file-local
 * aliases. Intersections and nested `Omit`s accumulate; a union of props shapes
 * keeps only the keys every branch omits, since a value of the other branch may
 * legitimately carry the rest.
 */
const omittedKeysOf = (typeNode, localTypes, open = new Set()): string[] => {
  if (typeNode === null || typeNode === undefined) {
    return [];
  }
  if (typeNode.type === "TSIntersectionType") {
    return typeNode.types.flatMap((member) =>
      omittedKeysOf(member, localTypes, open),
    );
  }
  if (typeNode.type === "TSUnionType") {
    const branches = typeNode.types.map(
      (member) => new Set(omittedKeysOf(member, localTypes, open)),
    );
    const first = branches.at(0);
    return first === undefined
      ? []
      : [...first].filter((key) => branches.every((branch) => branch.has(key)));
  }
  if (typeNode.type === "TSTypeReference") {
    const name = typeReferenceName(typeNode.typeName);
    const args = typeArgumentsOf(typeNode);
    if (name === OMIT_TYPE) {
      return [
        ...literalKeysOf(args.at(1)),
        // `Omit<Omit<P, "a">, "b">` omits both.
        ...omittedKeysOf(args.at(0), localTypes, open),
      ];
    }
    if (MODIFIER_UTILITIES.has(name)) {
      return omittedKeysOf(args.at(0), localTypes, open);
    }
    // A generic alias parameterized at the use site is not resolved here.
    const alias = expandAlias(name, localTypes, open);
    if (alias === null) {
      return [];
    }
    open.add(name);
    const keys = omittedKeysOf(alias, localTypes, open);
    open.delete(name);
    return keys;
  }
  return [];
};

/**
 * Keys the props type declares in its own right, outside the removed source
 * type. `Omit<P, "size"> & { size?: Local }` re-types `size` rather than
 * forbidding it, so the key is meant to reach the element.
 */
const reintroducedKeysOf = (
  typeNode,
  localTypes,
  open = new Set(),
): string[] => {
  if (typeNode === null || typeNode === undefined) {
    return [];
  }
  if (
    typeNode.type === "TSIntersectionType" ||
    typeNode.type === "TSUnionType"
  ) {
    return typeNode.types.flatMap((member) =>
      reintroducedKeysOf(member, localTypes, open),
    );
  }
  if (typeNode.type === "TSTypeLiteral") {
    return (typeNode.members ?? [])
      .filter((member) => member.type === "TSPropertySignature")
      .map((member) =>
        member.computed === true ? null : getPropertyName(member.key),
      )
      .filter((name) => name !== null);
  }
  if (typeNode.type === "TSTypeReference") {
    const name = typeReferenceName(typeNode.typeName);
    const args = typeArgumentsOf(typeNode);
    if (name === OMIT_TYPE) {
      // A member declared inside the source survives unless this `Omit` is the
      // one removing it: `Omit<Omit<P, "x"> & { x?: T }, "y">` still re-adds x.
      const removed = new Set(literalKeysOf(args.at(1)));
      return reintroducedKeysOf(args.at(0), localTypes, open).filter(
        (key) => !removed.has(key),
      );
    }
    if (MODIFIER_UTILITIES.has(name)) {
      return reintroducedKeysOf(args.at(0), localTypes, open);
    }
    const alias = expandAlias(name, localTypes, open);
    if (alias === null) {
      return [];
    }
    open.add(name);
    const keys = reintroducedKeysOf(alias, localTypes, open);
    open.delete(name);
    return keys;
  }
  return [];
};

// The pattern behind a default value: `(props: P = {})` parses the whole
// parameter as an assignment, with the binding and its annotation on the left.
const patternOf = (param) =>
  param?.type === "AssignmentPattern" ? param.left : param;

// The identifier that carries the rest of the props: the parameter itself, or
// the rest element of a destructuring pattern.
const propsBindingOf = (param) => {
  if (isIdentifier(param)) {
    return param;
  }
  if (param?.type !== "ObjectPattern") {
    return null;
  }
  const rest = param.properties?.find(
    (property) => property.type === "RestElement",
  );
  return isIdentifier(rest?.argument) ? rest.argument : null;
};

// Keys a destructuring pattern names before its rest element. A rest object
// provably excludes them, so no spread of it can carry the key.
const destructuredKeysOf = (param): string[] => {
  if (param?.type !== "ObjectPattern") {
    return [];
  }
  return (param.properties ?? [])
    .filter((property) => property.type === "Property" && !property.computed)
    .map((property) => getPropertyName(property.key))
    .filter((name) => name !== null);
};

// A plain attribute name. `JSXNamespacedName` (`xlink:href`) yields null: no
// omitted key spells that way.
const attributeName = (attribute) =>
  attribute?.type === "JSXAttribute" && attribute.name?.type === "JSXIdentifier"
    ? attribute.name.name
    : null;

// JSX children are passed positionally and override a spread `children` prop,
// so a real child counts as pinning the key. Whitespace-only text and a JSX
// comment (`{/* … */}`, an expression container holding nothing) emit no child.
const isRenderedChild = (child) => {
  if (child.type === "JSXText") {
    return child.value.trim() !== "";
  }
  return (
    child.type !== "JSXExpressionContainer" ||
    child.expression.type !== "JSXEmptyExpression"
  );
};

const hasMeaningfulChildren = (element) =>
  element.children.some(isRenderedChild);

// Whether a spread of this attribute could deliver `key`. An object literal is
// statically known: it can only deliver what it declares, spreads in, or
// computes. Anything else is opaque and assumed able to.
const spreadCanDeliver = (attribute, key) => {
  const argument = attribute.argument;
  if (argument.type !== "ObjectExpression") {
    return true;
  }
  return argument.properties.some(
    (property) =>
      property.type !== "Property" ||
      property.computed === true ||
      getPropertyName(property.key) === key,
  );
};

// The slice of the scope manager this rule reads: names visible at a node, and
// where each was bound. Oxlint does not publish these types.
type Scope = {
  set: Map<string, { defs: { name: { range: [number, number] } }[] }>;
  upper: Scope | null;
};

export default eslintCompatPlugin({
  meta: { name: "no-omitted-prop-respread" },
  rules: {
    "no-omitted-prop-respread": {
      meta: {
        type: "problem",
        messages: {
          pinnedBeforeSpread:
            "`{{key}}` is omitted from this component's props but written before the props spread, so the spread overwrites it. A value typed wider than the omitting parameter still carries `{{key}}` at runtime — `Omit` narrows what callers may write, not what a spread can deliver. Move the attribute after the last spread.",
          suppliedBySpread:
            "`{{key}}` is omitted from this component's props but the props spread can still deliver it: `Omit` narrows what callers may write literally, while a value typed wider stays assignable and keeps the key at runtime. Pin `{{key}}` after the last spread, or suppress with a reason if it is meant to pass through.",
        },
      },
      createOnce(context) {
        // Type aliases declared in this file, by name.
        const localTypes = new Map();
        // Keys each props binding omits, keyed by the start offset of its
        // binding identifier. Scope resolution maps a spread back to exactly one
        // binding, so any shadowing declaration wins over an enclosing one.
        const omittedByBinding = new Map<number, Set<string>>();

        // Props types are aliases here: `typescript/consistent-type-definitions`
        // keeps interfaces out of this codebase.
        const declareLocalType = (declaration) => {
          if (declaration?.type !== "TSTypeAliasDeclaration") {
            return;
          }
          const name = declaration.id?.name;
          if (typeof name === "string") {
            localTypes.set(name, declaration.typeAnnotation);
          }
        };

        const enterFunction = (node) => {
          const param = patternOf(node.params?.at(0));
          const binding = propsBindingOf(param);
          if (binding === null) {
            return;
          }
          const propsType = param.typeAnnotation?.typeAnnotation;
          // A key the pattern destructures is absent from the rest object, and
          // a key the props type re-declares is meant to pass through.
          const carried = new Set([
            ...destructuredKeysOf(param),
            ...reintroducedKeysOf(propsType, localTypes),
          ]);
          const keys = omittedKeysOf(propsType, localTypes).filter(
            (key) => !carried.has(key),
          );
          if (keys.length > 0) {
            omittedByBinding.set(binding.range[0], new Set(keys));
          }
        };

        // What the value behind a spread identifier is declared to omit, read
        // through the lexical scope chain: a nested binding of the same name, in
        // any parameter position or as a local, shadows an enclosing one.
        const omittedKeysForSpread = (identifier) => {
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope !== null) {
            const variable = scope.set.get(identifier.name);
            if (variable !== undefined) {
              return variable.defs
                .map((definition) =>
                  omittedByBinding.get(definition.name.range[0]),
                )
                .find((keys) => keys !== undefined);
            }
            scope = scope.upper;
          }
          return undefined;
        };

        return {
          Program(node) {
            localTypes.clear();
            omittedByBinding.clear();
            for (const statement of node.body) {
              declareLocalType(
                statement.type === "ExportNamedDeclaration"
                  ? statement.declaration
                  : statement,
              );
            }
          },
          ArrowFunctionExpression: enterFunction,
          FunctionDeclaration: enterFunction,
          FunctionExpression: enterFunction,
          JSXElement(node) {
            const attributes = node.openingElement.attributes;
            const omitted = new Set<string>();
            for (const attribute of attributes) {
              if (
                attribute.type !== "JSXSpreadAttribute" ||
                !isIdentifier(attribute.argument)
              ) {
                continue;
              }
              for (const key of omittedKeysForSpread(attribute.argument) ??
                []) {
                omitted.add(key);
              }
            }

            for (const key of omitted) {
              if (key === "children" && hasMeaningfulChildren(node)) {
                continue;
              }
              // Only a spread that could carry this key can override the pin.
              const lastOverrideIndex = attributes.findLastIndex(
                (attribute) =>
                  attribute.type === "JSXSpreadAttribute" &&
                  spreadCanDeliver(attribute, key),
              );
              if (lastOverrideIndex === -1) {
                continue;
              }
              const pin = attributes.find(
                (attribute) => attributeName(attribute) === key,
              );
              if (
                pin !== undefined &&
                attributes.indexOf(pin) > lastOverrideIndex
              ) {
                continue;
              }
              context.report({
                node: pin ?? node.openingElement,
                messageId:
                  pin === undefined ? "suppliedBySpread" : "pinnedBeforeSpread",
                data: { key },
              });
            }
          },
        };
      },
    },
  },
});
