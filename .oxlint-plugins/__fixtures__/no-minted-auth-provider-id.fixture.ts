// Passive regression fixture for
// `no-minted-auth-provider-id/no-minted-auth-provider-id`.
//
// Each `oxlint-disable-next-line` below suppresses a case the rule MUST flag.
// If the rule regresses, the matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

import { randomUUID } from "node:crypto";

type Branded<T extends string> = string & { readonly __brand: T };

const toSafeId = <T extends string>(value: string): Branded<T> =>
  value as Branded<T>;
const brandPersistedUserId = (value: string): Branded<"user"> =>
  toSafeId<"user">(value);
const row = { userId: "muhj1L1fC3PjrknOMMhCP6Cf0uieeuBZ" };

// A UUID minted under an auth-provider type argument.
// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _bunUser = toSafeId<"user">(Bun.randomUUIDv7());

// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _nodeOrganization = toSafeId<"organization">(randomUUID());

// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _webCryptoUser = toSafeId<"user">(crypto.randomUUID());

// The persisted brand implies the type argument.
// oxlint-disable-next-line no-minted-auth-provider-id/no-minted-auth-provider-id
const _branded = brandPersistedUserId(Bun.randomUUIDv7());

// Allowed: a stored value, and a minted id type.
const _stored = toSafeId<"user">(row.userId);
const _entity = toSafeId<"entity">(Bun.randomUUIDv7());
