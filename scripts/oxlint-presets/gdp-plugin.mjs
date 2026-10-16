import plugin from "@gdp-ts/core/lint/plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";

const noDefineProof = plugin.rules["no-define-proof"];
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const matterProofOwner = path.join(
  repoRoot,
  "apps/api/src/lib/workspaces/matter-access-proof.ts",
);
const checkedTransactionModule = path.join(
  repoRoot,
  "apps/api/src/lib/proofs/checked-transaction.ts",
);

const resolvedModule = (source, filename) => {
  if (source.startsWith("@/api/")) {
    const resolved = path.resolve(
      repoRoot,
      "apps/api/src",
      source.slice("@/api/".length),
    );
    return /\.[cm]?[jt]sx?$/u.test(resolved) ? resolved : `${resolved}.ts`;
  }
  if (!source.startsWith(".")) {
    return undefined;
  }
  const resolved = path.resolve(path.dirname(filename), source);
  return /\.[cm]?[jt]sx?$/u.test(resolved) ? resolved : `${resolved}.ts`;
};
const isMatterProofType = (
  node,
  { guarded, namespaces, filename, rawTypes },
) => {
  const hasMatterKind = (value) => {
    if (!value || typeof value !== "object") {
      return false;
    }
    if (["MatterReadable", "MatterWritable"].includes(value.value)) {
      return true;
    }
    return Object.entries(value).some(
      ([key, child]) =>
        key !== "parent" &&
        (Array.isArray(child)
          ? child.some(hasMatterKind)
          : hasMatterKind(child)),
    );
  };
  if (node?.type === "TSImportType") {
    const qualifier = node.qualifier;
    return (
      resolvedModule(node.source.value, filename) === matterProofOwner &&
      qualifier?.type === "Identifier" &&
      ["MatterReadable", "MatterWritable"].includes(qualifier.name)
    );
  }
  if (node?.type !== "TSTypeReference") {
    return false;
  }
  const name = node.typeName;
  if (name.type === "Identifier" && rawTypes.has(name.name)) {
    return hasMatterKind(node.typeParameters ?? node.typeArguments);
  }
  return name.type === "Identifier"
    ? guarded.has(name.name)
    : name.type === "TSQualifiedName" &&
        name.left.type === "Identifier" &&
        (guarded.has(name.left.name) || namespaces.has(name.left.name)) &&
        ["MatterReadable", "MatterWritable"].includes(name.right.name);
};

const noMatterProofForgery = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep matter access proof construction inside its predicate.",
    },
    schema: [],
  },
  create(context) {
    const filename = path.resolve(context.filename);
    if (filename === matterProofOwner) {
      return {};
    }
    const guarded = new Set();
    const namespaces = new Set();
    const rawTypes = new Set();
    const aliases = [];
    const pending = [];
    const message =
      "Only matter-access-proof.ts may cast or construct MatterReadable/MatterWritable.";
    const containsMatterProof = (node) => {
      if (!node || typeof node !== "object") {
        return false;
      }
      if (
        isMatterProofType(node, { guarded, namespaces, filename, rawTypes })
      ) {
        return true;
      }
      return Object.entries(node).some(
        ([key, value]) =>
          key !== "parent" &&
          (Array.isArray(value)
            ? value.some(containsMatterProof)
            : containsMatterProof(value)),
      );
    };
    const checkType = (node) => {
      if (containsMatterProof(node)) {
        context.report({ node, message });
      }
    };
    return {
      ImportDeclaration(node) {
        const source = resolvedModule(node.source.value, filename);
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            continue;
          }
          if (
            (node.source.value === "@gdp-ts/core" &&
              specifier.imported.name === "Proof") ||
            (source === checkedTransactionModule &&
              specifier.imported.name === "TransactionProof")
          ) {
            rawTypes.add(specifier.local.name);
          }
        }
        if (source === matterProofOwner) {
          for (const specifier of node.specifiers) {
            if (specifier.type === "ImportNamespaceSpecifier") {
              namespaces.add(specifier.local.name);
            }
            if (
              specifier.type === "ImportSpecifier" &&
              ["MatterReadable", "MatterWritable"].includes(
                specifier.imported.name,
              )
            ) {
              guarded.add(specifier.local.name);
            }
          }
        }
      },
      TSAsExpression(node) {
        pending.push(node.typeAnnotation);
      },
      TSTypeAssertion(node) {
        pending.push(node.typeAnnotation);
      },
      TSSatisfiesExpression(node) {
        pending.push(node.typeAnnotation);
      },
      // A generic helper (an identity cast, a test helper) can return any type
      // argument it is given, so naming a matter proof there constructs one.
      CallExpression(node) {
        pending.push(node.typeArguments ?? node.typeParameters);
      },
      NewExpression(node) {
        pending.push(node.typeArguments ?? node.typeParameters);
      },
      // An annotation only passes along an existing proof; any other value
      // (a literal, a parsed or spread copy, a call result) fabricates one.
      VariableDeclarator(node) {
        // Assertions are reported by their own visitors.
        if (
          node.init === null ||
          [
            "Identifier",
            "MemberExpression",
            "TSAsExpression",
            "TSSatisfiesExpression",
            "TSTypeAssertion",
          ].includes(node.init?.type)
        ) {
          return;
        }
        pending.push(node.id.typeAnnotation?.typeAnnotation);
      },
      TSTypeAliasDeclaration(node) {
        aliases.push(node);
      },
      "Program:exit"() {
        // Resolve forward references and alias chains before checking construction.
        let previousSize;
        do {
          previousSize = guarded.size;
          for (const alias of aliases) {
            if (containsMatterProof(alias.typeAnnotation)) {
              guarded.add(alias.id.name);
            }
          }
        } while (previousSize !== guarded.size);
        for (const node of pending) {
          checkType(node);
        }
      },
    };
  },
};

const noMatterProofKindOutsideOwner = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Reserve matter transaction proof kinds for their predicate owner.",
    },
    schema: [],
  },
  create(context) {
    const filename = path.resolve(context.filename);
    if (
      filename === matterProofOwner ||
      filename === checkedTransactionModule
    ) {
      return {};
    }
    const mintBindings = new Set();
    const mintNamespaces = new Set();
    const message =
      "MatterReadable and MatterWritable transaction proofs may only be minted by matter-access-proof.ts.";
    const MINT = "withCheckedTransaction";
    const memberName = (member) =>
      member.computed
        ? member.property.type === "Literal"
          ? member.property.value
          : undefined
        : member.property.name;
    const propertyName = (property) => {
      if (property.computed) {
        return property.key.type === "Literal" &&
          typeof property.key.value === "string"
          ? property.key.value
          : undefined;
      }
      return property.key.type === "Identifier"
        ? property.key.name
        : property.key.value;
    };
    // One shape is admitted outside the owner: the mint function called
    // directly with an inline options literal whose plain `kind` key holds a
    // string literal that is not a matter kind. A binding can be changed or
    // shadowed, a spread or unresolved computed key can supply another kind,
    // and the last of duplicate keys wins, so anything else is reported.
    const isSafeOptions = (expression) => {
      if (expression?.type !== "ObjectExpression") {
        return false;
      }
      let kind;
      for (const property of expression.properties) {
        if (property.type !== "Property") {
          return false;
        }
        const name = propertyName(property);
        if (name === undefined) {
          return false;
        }
        if (name === "kind") {
          kind = property.value;
        }
      }
      return (
        kind?.type === "Literal" &&
        typeof kind.value === "string" &&
        !["MatterReadable", "MatterWritable"].includes(kind.value)
      );
    };
    const isDirectCallee = (node) =>
      node.parent?.type === "CallExpression" && node.parent.callee === node;
    return {
      ImportDeclaration(node) {
        if (
          resolvedModule(node.source.value, filename) !==
            checkedTransactionModule ||
          node.importKind === "type"
        ) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            mintNamespaces.add(specifier.local.name);
          }
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.name === MINT &&
            specifier.importKind !== "type"
          ) {
            mintBindings.add(specifier.local.name);
          }
        }
      },
      ImportExpression(node) {
        // The minting module is never loaded dynamically outside its owners.
        if (
          node.source.type === "Literal" &&
          resolvedModule(node.source.value, filename) ===
            checkedTransactionModule
        ) {
          context.report({ node, message });
        }
      },
      // Every reference to the mint function, or to the namespace that
      // carries it, must be that direct call: aliases, `.call`/`.apply`,
      // destructuring, forwarding and re-exports cannot be followed safely.
      Identifier(node) {
        const parent = node.parent;
        if (
          parent?.type === "ImportSpecifier" ||
          parent?.type === "ImportNamespaceSpecifier" ||
          parent?.type === "TSQualifiedName" ||
          (parent?.type === "MemberExpression" &&
            parent.property === node &&
            !parent.computed) ||
          (parent?.type === "Property" && parent.key === node && !parent.shorthand)
        ) {
          return;
        }
        if (mintBindings.has(node.name)) {
          if (!isDirectCallee(node) || !isSafeOptions(parent.arguments.at(0))) {
            context.report({ node, message });
          }
          return;
        }
        if (!mintNamespaces.has(node.name)) {
          return;
        }
        if (parent?.type !== "MemberExpression" || parent.object !== node) {
          context.report({ node, message });
          return;
        }
        const name = memberName(parent);
        if (name === undefined) {
          context.report({ node, message });
          return;
        }
        if (
          name === MINT &&
          (!isDirectCallee(parent) || !isSafeOptions(parent.parent.arguments.at(0)))
        ) {
          context.report({ node, message });
        }
      },
    };
  },
};

// Preserve named calls and constructor extractions alongside upstream checks.
export default {
  ...plugin,
  rules: {
    ...plugin.rules,
    "no-matter-proof-forgery": noMatterProofForgery,
    "no-matter-proof-kind-outside-owner": noMatterProofKindOutsideOwner,
    "no-define-proof": {
      ...noDefineProof,
      create(context) {
        const upstream = noDefineProof.create(context);
        const constructors = new Set();
        const namespaces = new Set();
        const assignedValue = (node) =>
          node?.type === "AssignmentExpression"
            ? assignedValue(node.right)
            : node;
        const isConstructor = (node) => {
          const value = assignedValue(node);
          if (value?.type === "Identifier") {
            return constructors.has(value.name);
          }
          if (
            value?.type !== "MemberExpression" ||
            value.object.type !== "Identifier"
          ) {
            return false;
          }
          if (!namespaces.has(value.object.name)) {
            return false;
          }
          return value.computed
            ? value.property.value === "defineProof"
            : value.property.name === "defineProof";
        };
        const trackBinding = (target, value, node) => {
          if (isConstructor(value)) {
            if (target.type === "Identifier") {
              constructors.add(target.name);
            }
            context.report({
              node,
              message: "Only modules in proofs/ may extract defineProof.",
            });
            return;
          }
          const namespace = assignedValue(value);
          if (
            namespace?.type !== "Identifier" ||
            !namespaces.has(namespace.name)
          ) {
            return;
          }
          if (target.type === "Identifier") {
            namespaces.add(target.name);
            return;
          }
          if (target.type !== "ObjectPattern") {
            return;
          }
          for (const property of target.properties) {
            if (property.type !== "Property") {
              continue;
            }
            const key = property.computed
              ? property.key.value
              : (property.key.name ?? property.key.value);
            if (key !== "defineProof") {
              continue;
            }
            const binding =
              property.value.type === "AssignmentPattern"
                ? property.value.left
                : property.value;
            if (binding.type === "Identifier") {
              constructors.add(binding.name);
            }
            context.report({
              node: property,
              message: "Only modules in proofs/ may extract defineProof.",
            });
          }
        };
        return {
          ...upstream,
          ImportDeclaration(node) {
            upstream.ImportDeclaration(node);
            if (
              node.source.value !== "@gdp-ts/core" ||
              node.importKind === "type"
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportNamespaceSpecifier") {
                namespaces.add(specifier.local.name);
              }
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.importKind !== "type" &&
                specifier.imported.name === "defineProof"
              ) {
                constructors.add(specifier.local.name);
              }
            }
          },
          VariableDeclarator(node) {
            trackBinding(node.id, node.init, node);
          },
          AssignmentExpression(node) {
            trackBinding(node.left, node.right, node);
          },
          CallExpression(node) {
            upstream.CallExpression(node);
            if (
              node.callee.type === "Identifier" &&
              constructors.has(node.callee.name)
            ) {
              context.report({
                node,
                message: "Only modules in proofs/ may call defineProof.",
              });
            }
          },
        };
      },
    },
  },
};
