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
// Flagged:
//   toSafeId<"user">(Bun.randomUUIDv7())
//   toSafeId<"organization">(randomUUID())
//   toSafeId<"user">(crypto.randomUUID())
//   brandPersistedUserId(Bun.randomUUIDv7())
//
// Allowed:
//   mintAuthProviderId<"user">()          // tests: the real generator
//   toSafeId<"user">(row.userId)          // a stored value
//   toSafeId<"entity">(Bun.randomUUIDv7()) // a minted id type

import { eslintCompatPlugin } from "@oxlint/plugins";

const AUTH_PROVIDER_ID_TYPES = new Set(["user", "organization"]);

// Persisted-id brands whose type argument is implied by the name.
const AUTH_PROVIDER_BRAND_CALLEES = new Set([
  "brandPersistedUserId",
  "brandPersistedOrganizationId",
]);

const UUID_MINTER_PREFIX = "randomUUID";

type AstNode = { type: string } & Record<string, unknown>;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  typeof (node as { type?: unknown }).type === "string";

const calleeName = (callee: unknown): string | null => {
  if (!isAstNode(callee)) {
    return null;
  }
  if (callee.type === "Identifier" && typeof callee.name === "string") {
    return callee.name;
  }
  if (
    callee.type === "MemberExpression" &&
    isAstNode(callee.property) &&
    callee.property.type === "Identifier" &&
    typeof callee.property.name === "string"
  ) {
    return callee.property.name;
  }
  return null;
};

const mintsUuid = (argument: unknown): boolean => {
  if (!isAstNode(argument) || argument.type !== "CallExpression") {
    return false;
  }
  return calleeName(argument.callee)?.startsWith(UUID_MINTER_PREFIX) ?? false;
};

const firstTypeArgumentLiteral = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  const container = node.typeArguments ?? node.typeParameters;
  if (!isAstNode(container) || !Array.isArray(container.params)) {
    return null;
  }
  const first: unknown = container.params[0];
  if (
    !isAstNode(first) ||
    first.type !== "TSLiteralType" ||
    !isAstNode(first.literal) ||
    first.literal.type !== "Literal" ||
    typeof first.literal.value !== "string"
  ) {
    return null;
  }
  return first.literal.value;
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
        return {
          CallExpression(node) {
            const name = calleeName(node.callee);
            if (name === null) {
              return;
            }
            const brandedType = AUTH_PROVIDER_BRAND_CALLEES.has(name)
              ? name === "brandPersistedUserId"
                ? "user"
                : "organization"
              : firstTypeArgumentLiteral(node);
            if (
              brandedType === null ||
              !AUTH_PROVIDER_ID_TYPES.has(brandedType) ||
              !mintsUuid(node.arguments[0])
            ) {
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
