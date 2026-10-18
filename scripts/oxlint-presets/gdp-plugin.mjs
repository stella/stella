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
// The proof types, and the access context whose `proof` field is one: a
// type argument naming either constructs a proof through a generic helper.
const GUARDED_PROOF_TYPES = [
  "MatterReadable",
  "MatterWritable",
  "MatterAccessContext",
];
const isMatterProofType = (
  node,
  { guarded, namespaces, filename, rawTypes, callbackProofBindings },
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
      GUARDED_PROOF_TYPES.includes(qualifier.name)
    );
  }
  // `typeof context.proof` names a received proof's exact type.
  if (node?.type === "TSTypeQuery") {
    if (node.exprName?.type === "Identifier") {
      return callbackProofBindings.has(node.exprName);
    }
    return (
      node.exprName?.type === "TSQualifiedName" &&
      node.exprName.right.name === "proof"
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
        GUARDED_PROOF_TYPES.includes(name.right.name);
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
    const pendingExports = [];
    const accessBindings = new Set();
    const accessNamespaces = new Set();
    const callbackProofParameters = [];
    const message =
      "Only matter-access-proof.ts may cast or construct MatterReadable/MatterWritable.";
    const containsMatterProof = (node) => {
      if (!node || typeof node !== "object") {
        return false;
      }
      if (
        isMatterProofType(node, {
          guarded,
          namespaces,
          filename,
          rawTypes,
          callbackProofBindings,
        })
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
    const callbackProofBindings = new WeakSet();
    const variableFor = (identifier) => {
      let scope = context.sourceCode.getScope(identifier);
      while (scope) {
        const variable = scope.set.get(identifier.name);
        if (variable) {
          return variable;
        }
        scope = scope.upper;
      }
      return undefined;
    };
    const isAccessCall = (callee) =>
      (callee.type === "Identifier" && accessBindings.has(callee.name)) ||
      (callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        accessNamespaces.has(callee.object.name) &&
        !callee.computed &&
        callee.property.name === "withMatterAccess");
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
              if (node.importKind !== "type") {
                accessNamespaces.add(specifier.local.name);
              }
            }
            if (
              specifier.type === "ImportSpecifier" &&
              GUARDED_PROOF_TYPES.includes(specifier.imported.name)
            ) {
              guarded.add(specifier.local.name);
            }
            if (
              specifier.type === "ImportSpecifier" &&
              specifier.imported.name === "withMatterAccess" &&
              specifier.importKind !== "type" &&
              node.importKind !== "type"
            ) {
              accessBindings.add(specifier.local.name);
            }
          }
        }
      },
      // Re-exported proof types would reach other modules under names this
      // rule does not trace back to the owner.
      ExportNamedDeclaration(node) {
        if (
          node.source &&
          resolvedModule(node.source.value, filename) === matterProofOwner &&
          node.specifiers.some((specifier) =>
            GUARDED_PROOF_TYPES.includes(specifier.local.name),
          )
        ) {
          context.report({ node, message });
          return;
        }
        if (!node.source) {
          pendingExports.push(node);
        }
      },
      ExportAllDeclaration(node) {
        if (resolvedModule(node.source.value, filename) === matterProofOwner) {
          context.report({ node, message });
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
        if (!isAccessCall(node.callee)) {
          return;
        }
        const callback = node.arguments.at(1);
        const parameter = callback?.params?.at(0);
        if (parameter?.type !== "ObjectPattern") {
          return;
        }
        for (const property of parameter.properties) {
          if (
            property.type === "Property" &&
            !property.computed &&
            property.key.type === "Identifier" &&
            property.key.name === "proof" &&
            property.value.type === "Identifier"
          ) {
            callbackProofParameters.push(property.value);
          }
        }
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
        for (const identifier of callbackProofParameters) {
          const variable = variableFor(identifier);
          for (const reference of variable?.references ?? []) {
            callbackProofBindings.add(reference.identifier);
          }
        }
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
        for (const node of pendingExports) {
          const exportsGuardedAlias = node.specifiers.some(
            (specifier) =>
              specifier.local.type === "Identifier" &&
              guarded.has(specifier.local.name),
          );
          const exportsGuardedDeclaration =
            node.declaration?.type === "TSTypeAliasDeclaration" &&
            guarded.has(node.declaration.id.name);
          if (exportsGuardedAlias || exportsGuardedDeclaration) {
            context.report({ node, message });
          }
        }
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
      // A re-export would give other modules a facade that neither rule
      // resolves back to the boundary.
      ExportNamedDeclaration(node) {
        if (
          node.source &&
          resolvedModule(node.source.value, filename) ===
            checkedTransactionModule
        ) {
          context.report({ node, message });
        }
      },
      ExportAllDeclaration(node) {
        if (
          resolvedModule(node.source.value, filename) ===
          checkedTransactionModule
        ) {
          context.report({ node, message });
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
          // An export is reported once, at its local name.
          (parent?.type === "ExportSpecifier" &&
            parent.exported === node &&
            parent.local !== node) ||
          (parent?.type === "MemberExpression" &&
            parent.property === node &&
            !parent.computed) ||
          (parent?.type === "Property" &&
            parent.key === node &&
            !parent.shorthand)
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
          (!isDirectCallee(parent) ||
            !isSafeOptions(parent.parent.arguments.at(0)))
        ) {
          context.report({ node, message });
        }
      },
    };
  },
};

// The access context (`tx`, `matter`, `actor`, `proof`) is consumed inside the
// `withMatterAccess` callback. Its ghost names keep a returned or stored proof
// from type-checking, but a closure that captures them carries a plain function
// type out of the callback and could act after the transaction ended.
const noMatterAccessContextEscape = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Consume the matter access context inside its withMatterAccess callback.",
    },
    schema: [],
  },
  create(context) {
    const filename = path.resolve(context.filename);
    if (filename === matterProofOwner) {
      return {};
    }
    const accessBindings = new Set();
    const accessNamespaces = new Set();
    const message =
      "Consume the matter access context inside its withMatterAccess callback; do not return, store or capture it beyond the callback.";
    const isAccessCall = (callee) =>
      (callee.type === "Identifier" && accessBindings.has(callee.name)) ||
      (callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        accessNamespaces.has(callee.object.name) &&
        !callee.computed &&
        callee.property.name === "withMatterAccess");
    const children = (node) =>
      Object.entries(node).flatMap(([key, value]) => {
        if (key === "parent" || !value || typeof value !== "object") {
          return [];
        }
        return (Array.isArray(value) ? value : [value]).filter(
          (child) => child && typeof child.type === "string",
        );
      });
    const isFunction = (node) =>
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression" ||
      node.type === "FunctionDeclaration";
    const references = (node, names) => {
      if (node.type === "Identifier" && names.has(node.name)) {
        return true;
      }
      return children(node).some((child) => references(child, names));
    };
    const patternNames = (pattern, into) => {
      if (!pattern) {
        return into;
      }
      if (pattern.type === "Identifier") {
        into.add(pattern.name);
      } else if (pattern.type === "ObjectPattern") {
        for (const property of pattern.properties) {
          patternNames(
            property.type === "RestElement"
              ? property.argument
              : property.value,
            into,
          );
        }
      } else if (pattern.type === "ArrayPattern") {
        for (const element of pattern.elements) {
          patternNames(element, into);
        }
      } else if (pattern.type === "AssignmentPattern") {
        patternNames(pattern.left, into);
      } else if (pattern.type === "RestElement") {
        patternNames(pattern.argument, into);
      }
      return into;
    };
    const declaredWithin = (root) => {
      const declared = new Set();
      const visit = (node) => {
        if (node.type === "VariableDeclarator") {
          patternNames(node.id, declared);
        }
        if (isFunction(node)) {
          for (const param of node.params) {
            patternNames(param, declared);
          }
          if (node.id) {
            declared.add(node.id.name);
          }
        }
        for (const child of children(node)) {
          visit(child);
        }
      };
      visit(root);
      return declared;
    };
    // Wrappers that hand their argument back unchanged.
    const isTransparentCall = (node) => {
      const callee = node.callee;
      if (callee.type === "Identifier") {
        return ["Ok", "Err"].includes(callee.name);
      }
      return (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        !callee.computed &&
        ((callee.object.name === "Result" &&
          ["ok", "err"].includes(callee.property.name)) ||
          (callee.object.name === "Promise" &&
            callee.property.name === "resolve") ||
          (callee.object.name === "Object" &&
            ["assign", "freeze"].includes(callee.property.name)))
      );
    };
    // Whether evaluating `node` yields a context value or a closure over one.
    const carries = (node, names) => {
      if (!node) {
        return false;
      }
      switch (node.type) {
        case "Identifier": {
          return names.has(node.name);
        }
        case "MemberExpression": {
          // `.value` unwraps a named value into plain data (an id), which is
          // not evidence; any other member read keeps the context alive.
          return (
            !(!node.computed && node.property.name === "value") &&
            carries(node.object, names)
          );
        }
        case "ArrowFunctionExpression":
        case "FunctionExpression": {
          return references(node.body, names);
        }
        case "ObjectExpression": {
          return node.properties.some((property) =>
            carries(
              property.type === "SpreadElement"
                ? property.argument
                : property.value,
              names,
            ),
          );
        }
        case "ArrayExpression": {
          return node.elements.some((element) =>
            carries(
              element?.type === "SpreadElement" ? element.argument : element,
              names,
            ),
          );
        }
        case "ConditionalExpression": {
          return (
            carries(node.consequent, names) || carries(node.alternate, names)
          );
        }
        case "LogicalExpression": {
          return carries(node.left, names) || carries(node.right, names);
        }
        case "SequenceExpression": {
          return carries(node.expressions.at(-1), names);
        }
        case "AwaitExpression":
        case "TSAsExpression":
        case "TSSatisfiesExpression":
        case "TSNonNullExpression":
        case "TSTypeAssertion":
        case "ParenthesizedExpression": {
          return carries(node.expression ?? node.argument, names);
        }
        case "CallExpression": {
          return (
            isTransparentCall(node) &&
            node.arguments.some((argument) => carries(argument, names))
          );
        }
        default: {
          return false;
        }
      }
    };
    const rootIdentifier = (target) => {
      let node = target;
      while (node?.type === "MemberExpression") {
        node = node.object;
      }
      return node?.type === "Identifier" ? node.name : undefined;
    };
    // Locals bound to a carrying value (a closure over the context, an alias
    // of it) carry it as well; repeat until no new name is added.
    const carryingLocals = (root, names) => {
      const declarators = [];
      const collect = (node) => {
        if (
          node.type === "VariableDeclarator" &&
          node.id.type === "Identifier"
        ) {
          declarators.push(node);
        }
        for (const child of children(node)) {
          collect(child);
        }
      };
      collect(root);
      let size;
      do {
        size = names.size;
        for (const declarator of declarators) {
          if (carries(declarator.init, names)) {
            names.add(declarator.id.name);
          }
        }
      } while (names.size !== size);
      return names;
    };
    const checkCallback = (callback) => {
      const names = carryingLocals(
        callback.body,
        patternNames(callback.params.at(0), new Set()),
      );
      // Locals bound to a function that captures the context.
      const closureNames = new Set();
      const collectClosures = (node) => {
        if (
          node.type === "VariableDeclarator" &&
          node.id.type === "Identifier" &&
          node.init &&
          (node.init.type === "ArrowFunctionExpression" ||
            node.init.type === "FunctionExpression") &&
          references(node.init.body, names)
        ) {
          closureNames.add(node.id.name);
        }
        if (
          node.type === "FunctionDeclaration" &&
          node.id &&
          references(node.body, names)
        ) {
          closureNames.add(node.id.name);
        }
        for (const child of children(node)) {
          collectClosures(child);
        }
      };
      collectClosures(callback.body);
      // A capturing function, declared or bound, carries the context wherever
      // it goes (a return, an outer store), not only into a call.
      for (const name of closureNames) {
        names.add(name);
      }
      const local = declaredWithin(callback.body);
      const isOuter = (target) => {
        const root = rootIdentifier(target);
        return root === undefined || !local.has(root);
      };
      if (callback.body.type !== "BlockStatement") {
        if (carries(callback.body, names)) {
          context.report({ node: callback.body, message });
        }
      }
      const visit = (node, nested) => {
        if (
          !nested &&
          node.type === "ReturnStatement" &&
          carries(node.argument, names)
        ) {
          context.report({ node, message });
        }
        if (
          node.type === "AssignmentExpression" &&
          isOuter(node.left) &&
          carries(node.right, names)
        ) {
          context.report({ node, message });
        }
        let stored = false;
        if (
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          isOuter(node.callee.object) &&
          node.arguments.some((argument) => carries(argument, names))
        ) {
          // Storing into an outer collection (push, set, add) keeps it alive.
          const method = node.callee.computed
            ? undefined
            : node.callee.property.name;
          if (["push", "unshift", "set", "add", "splice"].includes(method)) {
            context.report({ node, message });
            stored = true;
          }
        }
        // A function that captures the context may only be handed to a call
        // the callback awaits (or returns): otherwise it can run after the
        // transaction ended (a timer, an un-awaited forEach, a microtask).
        if (
          !stored &&
          (node.type === "CallExpression" || node.type === "NewExpression") &&
          node.arguments.some((argument) => isCapturingFunction(argument)) &&
          (isScheduling(node) || !isAwaitedWithin(node))
        ) {
          context.report({ node, message });
        }
        for (const child of children(node)) {
          visit(child, nested || isFunction(child));
        }
      };
      // These never wait for the callback, so awaiting their result settles
      // nothing (a timer handle, forEach's undefined).
      const SCHEDULERS = new Set([
        "setTimeout",
        "setInterval",
        "setImmediate",
        "queueMicrotask",
        "nextTick",
        "forEach",
        "addEventListener",
        "on",
        "once",
      ]);
      const isScheduling = (call) => {
        const callee = call.callee;
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" && !callee.computed
              ? callee.property.name
              : undefined;
        return name !== undefined && SCHEDULERS.has(name);
      };
      const isCapturingFunction = (argument) =>
        ((argument.type === "ArrowFunctionExpression" ||
          argument.type === "FunctionExpression") &&
          references(argument.body, names)) ||
        (argument.type === "Identifier" && closureNames.has(argument.name));
      // Up from `node` to the callback body: an await, or the callback's own
      // return, before any nested function boundary.
      const isAwaitedWithin = (node) => {
        let settled = false;
        let current = node.parent;
        while (current && current !== callback) {
          if (isFunction(current)) {
            // An await inside a nested function only settles that function,
            // which is itself checked where it is handed on.
            return false;
          }
          if (
            current.type === "AwaitExpression" ||
            current.type === "ReturnStatement"
          ) {
            settled = true;
          }
          current = current.parent;
        }
        // An expression-bodied callback returns its value to the awaiting caller.
        return settled || callback.body.type !== "BlockStatement";
      };
      visit(callback.body, false);
    };
    return {
      ImportDeclaration(node) {
        if (resolvedModule(node.source.value, filename) !== matterProofOwner) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            accessNamespaces.add(specifier.local.name);
          }
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.name === "withMatterAccess"
          ) {
            accessBindings.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (!isAccessCall(node.callee)) {
          return;
        }
        const callback = node.arguments.at(1);
        // Only an inline callback can be checked for escapes.
        if (
          callback?.type !== "ArrowFunctionExpression" &&
          callback?.type !== "FunctionExpression"
        ) {
          context.report({ node, message });
          return;
        }
        checkCallback(callback);
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
    "no-matter-access-context-escape": noMatterAccessContextEscape,
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
            upstream.ImportDeclaration?.(node);
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
            upstream.CallExpression?.(node);
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
