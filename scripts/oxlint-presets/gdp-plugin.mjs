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
      VariableDeclarator(node) {
        if (node.init?.type !== "ObjectExpression") {
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
    const kindBindings = new Map();
    const optionBindings = new Map();
    const message =
      "MatterReadable and MatterWritable transaction proofs may only be minted by matter-access-proof.ts.";
    const isMintCall = (callee) =>
      (callee.type === "Identifier" && mintBindings.has(callee.name)) ||
      (callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        mintNamespaces.has(callee.object.name) &&
        (callee.computed
          ? callee.property.value === "withCheckedTransaction"
          : callee.property.name === "withCheckedTransaction"));
    const kindDisposition = (expression) => {
      if (
        expression?.type === "Literal" &&
        typeof expression.value === "string"
      ) {
        return ["MatterReadable", "MatterWritable"].includes(expression.value)
          ? "matter"
          : "safe";
      }
      return expression?.type === "Identifier"
        ? kindBindings.get(expression.name)
        : undefined;
    };
    const optionsDisposition = (expression) => {
      if (expression?.type === "Identifier") {
        return optionBindings.get(expression.name);
      }
      if (expression?.type !== "ObjectExpression") {
        return undefined;
      }
      const property = expression.properties.find(
        (candidate) =>
          candidate.type === "Property" &&
          (candidate.computed
            ? candidate.key.value === "kind"
            : candidate.key.name === "kind"),
      );
      return property ? kindDisposition(property.value) : undefined;
    };
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
            specifier.imported.name === "withCheckedTransaction" &&
            specifier.importKind !== "type"
          ) {
            mintBindings.add(specifier.local.name);
          }
        }
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier") {
          return;
        }
        if (
          node.init?.type === "Identifier" &&
          mintBindings.has(node.init.name)
        ) {
          mintBindings.add(node.id.name);
        }
        const kind = kindDisposition(node.init);
        if (kind) {
          kindBindings.set(node.id.name, kind);
        }
        const options = optionsDisposition(node.init);
        if (options) {
          optionBindings.set(node.id.name, options);
        }
      },
      CallExpression(node) {
        if (
          isMintCall(node.callee) &&
          optionsDisposition(node.arguments.at(0)) !== "safe"
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
