import { generateId } from "@better-auth/core/utils/id";

import { toSafeId } from "@/api/lib/branded-types";
import type { AuthProviderIdType, SafeId } from "@/api/lib/branded-types";

// Better Auth's default id length; `AUTH_DATABASE_ID_OPTIONS` declares no
// generator, so this is exactly what the `user`, `organization`, and `member`
// rows in production hold. Fixtures mint auth-provider ids here rather than
// with `Bun.randomUUIDv7()` so every suite exercises the stored shape; a UUID
// fixture once hid a predicate that rejected every real member.
const BETTER_AUTH_DEFAULT_ID_LENGTH = 32;

export const mintAuthProviderIdValue = (): string =>
  generateId(BETTER_AUTH_DEFAULT_ID_LENGTH);

export const mintAuthProviderId = <T extends AuthProviderIdType>(): SafeId<T> =>
  toSafeId<T>(mintAuthProviderIdValue());
