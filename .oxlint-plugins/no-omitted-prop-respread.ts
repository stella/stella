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
//     file-local type aliases are followed.
//   - `Omit` is matched by name. A shadowed or re-exported `Omit` is not
//     distinguished.
//   - The omission must be written on the parameter. A props type inferred from
//     a generic wrapper (`forwardRef<Ref, Omit<P, "k">>`) is not read.
//   - JSX children override a spread `children` prop, so an element with
//     children satisfies an omitted `children` key.
//
// When a key legitimately passes through by design, suppress the finding with
// `// eslint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread`
// and a reason. The rule is not in `TRACKED_SUPPRESSION_RULES`, so the
// directive is charged to the residual suppression budget in `scripts/ratchet.ts`:
// the exception is still countable and decrease-only, without claiming a tenancy,
// capacity, or diagnosability tier it does not guard. The repo carries none today.

import { getPropertyName, isIdentifier } from "./utils.ts";

const OMIT_TYPE = "Omit";

// Local alias chains are short in practice; the cap only bounds a cycle.
const MAX_ALIAS_DEPTH = 4;

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
const omittedKeysOf = (typeNode, localTypes, depth = 0): string[] => {
  if (typeNode === null || typeNode === undefined || depth > MAX_ALIAS_DEPTH) {
    return [];
  }
  if (typeNode.type === "TSIntersectionType") {
    return typeNode.types.flatMap((member) =>
      omittedKeysOf(member, localTypes, depth),
    );
  }
  if (typeNode.type === "TSUnionType") {
    const branches = typeNode.types.map(
      (member) => new Set(omittedKeysOf(member, localTypes, depth)),
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
        ...omittedKeysOf(args.at(0), localTypes, depth),
      ];
    }
    const alias = name === null ? undefined : localTypes.get(name);
    // A generic alias parameterized at the use site is not resolved here.
    return alias === undefined
      ? []
      : omittedKeysOf(alias, localTypes, depth + 1);
  }
  return [];
};

/**
 * Keys the props type declares in its own right, outside the removed source
 * type. `Omit<P, "size"> & { size?: Local }` re-types `size` rather than
 * forbidding it, so the key is meant to reach the element.
 */
const reintroducedKeysOf = (typeNode, localTypes, depth = 0): string[] => {
  if (typeNode === null || typeNode === undefined || depth > MAX_ALIAS_DEPTH) {
    return [];
  }
  if (
    typeNode.type === "TSIntersectionType" ||
    typeNode.type === "TSUnionType"
  ) {
    return typeNode.types.flatMap((member) =>
      reintroducedKeysOf(member, localTypes, depth),
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
    // `Omit`'s own source type is what the omission removes from, so its
    // members are not a reintroduction.
    if (name === OMIT_TYPE) {
      return [];
    }
    const alias = name === null ? undefined : localTypes.get(name);
    return alias === undefined
      ? []
      : reintroducedKeysOf(alias, localTypes, depth + 1);
  }
  return [];
};

// The binding that carries the rest of the props: the parameter identifier, or
// the rest element of a destructuring pattern.
const propsBindingOf = (param) => {
  if (isIdentifier(param)) {
    return param.name;
  }
  if (param?.type !== "ObjectPattern") {
    return null;
  }
  const rest = param.properties?.find(
    (property) => property.type === "RestElement",
  );
  return isIdentifier(rest?.argument) ? rest.argument.name : null;
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
// so anything other than insignificant whitespace counts as pinning the key.
const hasMeaningfulChildren = (element) =>
  (element.children ?? []).some(
    (child) => child.type !== "JSXText" || child.value.trim() !== "",
  );

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
        // One frame per enclosing function: the props binding it introduces and
        // the literal keys its parameter type omits.
        const scopes: { binding: string | null; keys: Set<string> }[] = [];

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
          const param = node.params?.at(0);
          const binding = propsBindingOf(param);
          if (binding === null) {
            scopes.push({ binding, keys: new Set() });
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
          scopes.push({ binding, keys: new Set(keys) });
        };

        const exitFunction = () => {
          scopes.pop();
        };

        return {
          Program(node) {
            localTypes.clear();
            scopes.length = 0;
            for (const statement of node.body) {
              declareLocalType(
                statement.type === "ExportNamedDeclaration"
                  ? statement.declaration
                  : statement,
              );
            }
          },
          ArrowFunctionExpression: enterFunction,
          "ArrowFunctionExpression:exit": exitFunction,
          FunctionDeclaration: enterFunction,
          "FunctionDeclaration:exit": exitFunction,
          FunctionExpression: enterFunction,
          "FunctionExpression:exit": exitFunction,
          JSXElement(node) {
            const attributes = node.openingElement.attributes;
            // Only a spread of a named value can smuggle a key; an object
            // literal spread is statically known. Any spread can override an
            // earlier attribute, so the pin has to clear the last one.
            const spreadNames = new Set<string>();
            let lastSpreadIndex = -1;
            for (const [index, attribute] of attributes.entries()) {
              if (attribute.type !== "JSXSpreadAttribute") {
                continue;
              }
              lastSpreadIndex = index;
              if (isIdentifier(attribute.argument)) {
                spreadNames.add(attribute.argument.name);
              }
            }

            // The innermost enclosing component whose props reach this element.
            const scope = scopes.findLast(
              (candidate) =>
                candidate.binding !== null &&
                candidate.keys.size > 0 &&
                spreadNames.has(candidate.binding),
            );
            if (scope === undefined) {
              return;
            }

            for (const key of scope.keys) {
              if (key === "children" && hasMeaningfulChildren(node)) {
                continue;
              }
              const pin = attributes.find(
                (attribute) => attributeName(attribute) === key,
              );
              if (
                pin !== undefined &&
                attributes.indexOf(pin) > lastSpreadIndex
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
