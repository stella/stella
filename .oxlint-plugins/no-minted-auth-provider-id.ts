// Ban minting a UUID for an id the auth provider owns.
//
// `user` and `organization` ids are opaque text from the auth provider (32
// base62 characters by default), never UUIDs. `createSafeId` already refuses
// those types at the type level; this rule closes the spelling the type
// system cannot see, where a UUID is handed to `toSafeId` (or a persisted-id
// brand) under an auth-provider type argument. A fixture built that way
// passes every suite while exercising a shape no real row carries, which is
// how a UUID-only predicate over user ids once rejected every real member.
//
// The UUID may arrive directly or through a file-local binding whose every
// initializer is a UUID call (`const id = Bun.randomUUIDv7()`), and the
// minter may be an import alias (`import { randomUUID as mint }`). The type
// argument may be a literal, a union containing one, or the canonical
// `AuthProviderIdType` alias. Only `toSafeId` and the persisted user and
// organization brands are inspected; an unrelated generic that happens to
// take a `"user"` type argument is not a branding call.
//
// Flagged:
//   toSafeId<"user">(Bun.randomUUIDv7())
//   toSafeId<"organization">(randomUUID())
//   toSafeId<"user" | "organization">(crypto.randomUUID())
//   toSafeId<AuthProviderIdType>(Bun.randomUUIDv7())
//   const id = Bun.randomUUIDv7(); toSafeId<"user">(id)
//   brandPersistedUserId(Bun.randomUUIDv7())
//
// Allowed:
//   mintAuthProviderId<"user">()            // tests: the real generator
//   toSafeId<"user">(row.userId)            // a stored value
//   toSafeId<"entity">(Bun.randomUUIDv7())  // a minted id type
//   fetchFixture<"user">(Bun.randomUUIDv7()) // not a branding call

import { eslintCompatPlugin } from "@oxlint/plugins";

const AUTH_PROVIDER_ID_TYPES = new Set(["user", "organization"]);
const AUTH_PROVIDER_ID_TYPE_ALIAS = "AuthProviderIdType";

const BRANDING_CALLEE = "toSafeId";

// Persisted-id brands whose type argument is implied by the name.
const AUTH_PROVIDER_BRAND_CALLEES: ReadonlyMap<string, string> = new Map([
  ["brandPersistedUserId", "user"],
  ["brandPersistedOrganizationId", "organization"],
]);

const UUID_MINTER_PREFIX = "randomUUID";

type AstNode = { type: string } & Record<string, unknown>;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  typeof (node as { type?: unknown }).type === "string";

const identifierName = (node: unknown): string | null =>
  isAstNode(node) && node.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : null;

const calleeName = (callee: unknown): string | null => {
  if (!isAstNode(callee)) {
    return null;
  }
  if (callee.type === "MemberExpression") {
    return identifierName(callee.property);
  }
  return identifierName(callee);
};

// Walk every node of a subtree once; the AST is a plain object graph.
const walk = (node: unknown, visit: (node: AstNode) => void): void => {
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visit);
    }
    return;
  }
  if (!isAstNode(node)) {
    return;
  }
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "parent" && typeof value === "object" && value !== null) {
      walk(value, visit);
    }
  }
};

const typeArgumentIsAuthProvider = (typeNode: unknown): boolean => {
  if (!isAstNode(typeNode)) {
    return false;
  }
  if (typeNode.type === "TSLiteralType") {
    return (
      isAstNode(typeNode.literal) &&
      typeNode.literal.type === "Literal" &&
      typeof typeNode.literal.value === "string" &&
      AUTH_PROVIDER_ID_TYPES.has(typeNode.literal.value)
    );
  }
  if (typeNode.type === "TSUnionType" && Array.isArray(typeNode.types)) {
    return typeNode.types.some((member) => typeArgumentIsAuthProvider(member));
  }
  if (typeNode.type === "TSTypeReference") {
    return identifierName(typeNode.typeName) === AUTH_PROVIDER_ID_TYPE_ALIAS;
  }
  return false;
};

const brandedAuthProviderType = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  const callee = calleeName(node.callee);
  if (callee === null) {
    return null;
  }
  const implied = AUTH_PROVIDER_BRAND_CALLEES.get(callee);
  if (implied !== undefined) {
    return implied;
  }
  if (callee !== BRANDING_CALLEE) {
    return null;
  }
  const container = node.typeArguments ?? node.typeParameters;
  if (!isAstNode(container) || !Array.isArray(container.params)) {
    return null;
  }
  const first: unknown = container.params[0];
  return typeArgumentIsAuthProvider(first) ? "auth-provider" : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-minted-auth-provider-id" },
  rules: {
    "no-minted-auth-provider-id": {
      meta: {
        type: "problem",
        messages: {
          mintedAuthProviderId:
            "`{{idType}}` ids are minted by the auth provider and are not " +
            "UUIDs. Use a stored value, or `mintAuthProviderId` in tests, " +
            "instead of a generated UUID.",
        },
      },
      createOnce(context) {
        // Names that mint a UUID when called: the well-known minters plus
        // import aliases of them. Rebuilt per file.
        let minterNames = new Set<string>();
        // File-local bindings whose every initializer is a UUID call. A name
        // that is also bound to something else anywhere in the file is not
        // trusted, so shadowing cannot produce a false positive.
        let uuidBindings = new Set<string>();

        const mintsUuid = (argument: unknown): boolean => {
          if (!isAstNode(argument)) {
            return false;
          }
          if (argument.type === "CallExpression") {
            const name = calleeName(argument.callee);
            return (
              name !== null &&
              (name.startsWith(UUID_MINTER_PREFIX) || minterNames.has(name))
            );
          }
          const name = identifierName(argument);
          return name !== null && uuidBindings.has(name);
        };

        return {
          Program(program) {
            minterNames = new Set<string>();
            const uuidBound = new Set<string>();
            const otherwiseBound = new Set<string>();

            walk(program, (node) => {
              if (node.type === "ImportSpecifier") {
                const imported = identifierName(node.imported);
                const local = identifierName(node.local);
                if (
                  imported !== null &&
                  local !== null &&
                  imported.startsWith(UUID_MINTER_PREFIX)
                ) {
                  minterNames.add(local);
                }
                return;
              }
              if (node.type !== "VariableDeclarator") {
                return;
              }
              const name = identifierName(node.id);
              if (name === null) {
                return;
              }
              const init = node.init;
              const initMintsUuid =
                isAstNode(init) &&
                init.type === "CallExpression" &&
                (() => {
                  const callee = calleeName(init.callee);
                  return (
                    callee !== null &&
                    (callee.startsWith(UUID_MINTER_PREFIX) ||
                      minterNames.has(callee))
                  );
                })();
              (initMintsUuid ? uuidBound : otherwiseBound).add(name);
            });

            uuidBindings = new Set(
              [...uuidBound].filter((name) => !otherwiseBound.has(name)),
            );
          },
          CallExpression(node) {
            const brandedType = brandedAuthProviderType(node);
            if (brandedType === null || !mintsUuid(node.arguments[0])) {
              return;
            }
            context.report({
              node,
              messageId: "mintedAuthProviderId",
              data: { idType: brandedType },
            });
          },
        };
      },
    },
  },
});
