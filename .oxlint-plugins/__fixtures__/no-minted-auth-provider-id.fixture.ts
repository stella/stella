// Passive regression fixture for
// `no-minted-auth-provider-id/no-minted-auth-provider-id`.
//
// Each `oxlint-disable-next-line` below suppresses a case the rule MUST flag.
// If the rule regresses, the matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

import { randomUUID, randomUUID as mint } from "node:crypto";

type Branded<T extends string> = string & { readonly __brand: T };
type AuthProviderIdType = "organization" | "user";

// Declared, not implemented: the rule reads call shapes, and an implementation
// would need the very cast the type-aware lint forbids.
declare const toSafeId: <T extends string>(value: string) => Branded<T>;
declare const brandPersistedUserId: (value: string) => Branded<"user">;
declare const fetchFixture: <T extends string>(value: string) => Branded<T>;
declare const row: { userId: string };

// A UUID minted under an auth-provider type argument.
// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _bunUser = toSafeId<"user">(Bun.randomUUIDv7());

// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _nodeOrganization = toSafeId<"organization">(randomUUID());

// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _webCryptoUser = toSafeId<"user">(crypto.randomUUID());

// A union that contains an auth-provider member, and the canonical alias.
// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _union = toSafeId<"user" | "organization">(Bun.randomUUIDv7());
// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _alias = toSafeId<AuthProviderIdType>(Bun.randomUUIDv7());

// The UUID laundered through a file-local binding, and through an import
// alias of the minter.
const generated = Bun.randomUUIDv7();
// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _viaBinding = toSafeId<"user">(generated);
// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _viaAlias = toSafeId<"organization">(mint());

// The persisted brand implies the type argument.
// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _branded = brandPersistedUserId(Bun.randomUUIDv7());

// Allowed: a stored value, a minted id type, a binding that is not always a
// UUID, and a generic call that is not a branding call.
const _stored = toSafeId<"user">(row.userId);
const _entity = toSafeId<"entity">(Bun.randomUUIDv7());
const _notBranding = fetchFixture<"user">(Bun.randomUUIDv7());
const ambiguous = row.userId;
const _fromAmbiguous = toSafeId<"user">(ambiguous);
