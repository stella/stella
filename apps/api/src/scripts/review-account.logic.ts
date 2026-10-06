import type { AuthContext } from "better-auth";
import { Result, TaggedError } from "better-result";

import type { createReviewAccountOrganizationStore } from "@/api/lib/auth/review-account-organization-store";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";

/**
 * Operator commands for the restricted review account. The account and its
 * organization cannot be created through the product (the account policy
 * refuses it), so `provision` writes them directly, and `set-password` sets
 * the password from standard input. Nothing secret is ever printed: outcomes
 * are fixed words and counts.
 */

export const REVIEW_PASSWORD_MIN_LENGTH = 16;
/** Better Auth's own maximum; a longer password could never sign in. */
export const REVIEW_PASSWORD_MAX_LENGTH = 128;
const STDIN_MAX_BYTES = 4096;

export class ReviewAccountCommandError extends TaggedError(
  "ReviewAccountCommandError",
)<{
  code:
    | "not-configured"
    | "demo-account"
    | "organization-has-other-members"
    | "account-in-other-organization"
    | "two-factor-enabled"
    | "account-missing"
    | "password-too-short"
    | "password-too-long"
    | "password-unreadable";
  message: string;
}> {}

type ReviewAccountConfig = {
  email: string | undefined;
  organizationId: string | undefined;
};

export type ReviewAccountStore = {
  findUserIdByEmail: (email: string) => Promise<string | null>;
  hasTwoFactorEnabled: (userId: string) => Promise<boolean>;
  createUser: (email: string) => Promise<string>;
  organizationExists: (organizationId: string) => Promise<boolean>;
  listMemberUserIds: (organizationId: string) => Promise<string[]>;
  listOrganizationIdsForUser: (userId: string) => Promise<string[]>;
  /** Creates the organization with this user as its only owner. */
  createOrganization: (options: {
    organizationId: string;
    ownerUserId: string;
  }) => Promise<void>;
  addOwner: (options: {
    organizationId: string;
    userId: string;
  }) => Promise<void>;
  /** Hashes and stores the password through Better Auth. */
  setPassword: (options: { userId: string; password: string }) => Promise<void>;
  /** Ends the account's browser sessions; OAuth grants are left alone. */
  revokeSessions: (userId: string) => Promise<number>;
  /** Deletes outstanding reset tokens and emailed codes for the account. */
  revokeVerifications: (options: {
    userId: string;
    email: string;
  }) => Promise<number>;
};

/** The email-otp code types that name the account by its address alone. */
export const REVIEW_ACCOUNT_OTP_TYPES = [
  "sign-in",
  "email-verification",
  "forget-password",
] as const;

type AuthAccountStore = Pick<
  ReviewAccountStore,
  | "findUserIdByEmail"
  | "hasTwoFactorEnabled"
  | "createUser"
  | "setPassword"
  | "revokeSessions"
  | "revokeVerifications"
>;

/** The account half of the store, written through Better Auth itself. */
export const createReviewAccountAuthStore = (context: {
  adapter: Pick<AuthContext["adapter"], "deleteMany">;
  internalAdapter: AuthContext["internalAdapter"];
  password: Pick<AuthContext["password"], "hash">;
}): AuthAccountStore => ({
  findUserIdByEmail: async (email) =>
    (await context.internalAdapter.findUserByEmail(email))?.user.id ?? null,
  hasTwoFactorEnabled: async (userId) => {
    const user: unknown = await context.internalAdapter.findUserById(userId);
    return (
      typeof user === "object" &&
      user !== null &&
      Reflect.get(user, "twoFactorEnabled") === true
    );
  },
  createUser: async (email) =>
    (
      await context.internalAdapter.createUser(
        { email, name: "Reviewer", emailVerified: true },
        { method: "admin" },
      )
    ).id,
  setPassword: async ({ userId, password }) => {
    const hash = await context.password.hash(password);
    const accounts = await context.internalAdapter.findAccounts(userId);
    if (
      accounts.some(
        (account) =>
          account.providerId === "credential" && account.accountId === userId,
      )
    ) {
      await context.internalAdapter.updatePassword(userId, hash);
      return;
    }
    await context.internalAdapter.linkAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: hash,
    });
  },
  revokeSessions: async (userId) => {
    const sessions = await context.internalAdapter.listSessions(userId);
    await context.internalAdapter.deleteUserSessions(userId);
    return sessions.length;
  },
  // Reset and account-deletion tokens carry the user id as their value.
  // Email-verification and email-change links are signed tokens, not stored,
  // and are checked when redeemed. Emailed codes are keyed
  // exactly `<type>-otp-<email>` (better-auth email-otp `toOTPIdentifier`).
  // Change-email codes also name the new address, so they cannot be named
  // exactly; the account policy refuses every email change for this account.
  revokeVerifications: async ({ userId, email }) =>
    (await context.adapter.deleteMany({
      model: "verification",
      where: [{ field: "value", value: userId }],
    })) +
    (await context.adapter.deleteMany({
      model: "verification",
      where: [
        {
          field: "identifier",
          operator: "in",
          value: REVIEW_ACCOUNT_OTP_TYPES.map((type) => `${type}-otp-${email}`),
        },
      ],
    })),
});

type OrganizationStoreHalf = Pick<
  ReviewAccountStore,
  | "organizationExists"
  | "listMemberUserIds"
  | "listOrganizationIdsForUser"
  | "createOrganization"
  | "addOwner"
>;

/**
 * Adapts the owner-bound organization store to the command's plain ids. Ids
 * come from the validated environment and stored auth rows, so they are
 * branded here, at the command boundary.
 */
export const bindReviewAccountOrganizationStore = (
  organizations: ReturnType<typeof createReviewAccountOrganizationStore>,
): OrganizationStoreHalf => ({
  organizationExists: async (organizationId) =>
    await organizations.organizationExists(
      brandPersistedOrganizationId(organizationId),
    ),
  listMemberUserIds: async (organizationId) =>
    await organizations.listMemberUserIds(
      brandPersistedOrganizationId(organizationId),
    ),
  listOrganizationIdsForUser: async (userId) =>
    await organizations.listOrganizationIdsForUser(
      brandPersistedUserId(userId),
    ),
  createOrganization: async ({ organizationId, ownerUserId }) => {
    await organizations.createOrganization({
      organizationId: brandPersistedOrganizationId(organizationId),
      ownerUserId: brandPersistedUserId(ownerUserId),
    });
  },
  addOwner: async ({ organizationId, userId }) => {
    await organizations.addOwner({
      organizationId: brandPersistedOrganizationId(organizationId),
      userId: brandPersistedUserId(userId),
    });
  },
});

const normalize = (email: string) => email.trim().toLowerCase();

const twoFactorRefusal = () =>
  Result.err(
    new ReviewAccountCommandError({
      code: "two-factor-enabled",
      message:
        "The account has two-factor authentication enabled; the review account must not. Disable it through the owner path first, or configure another address.",
    }),
  );

/** Refuses an existing account that could not serve as the review account. */
const checkExistingAccount = async ({
  organizationId,
  store,
  userId,
}: {
  organizationId: string;
  store: ReviewAccountStore;
  userId: string;
}): Promise<Result<void, ReviewAccountCommandError>> => {
  if (await store.hasTwoFactorEnabled(userId)) {
    return twoFactorRefusal();
  }
  const otherOrganizations = (
    await store.listOrganizationIdsForUser(userId)
  ).filter((id) => id !== organizationId);
  return otherOrganizations.length > 0
    ? Result.err(
        new ReviewAccountCommandError({
          code: "account-in-other-organization",
          message:
            "The account belongs to another organization; the review account may belong to its own organization only.",
        }),
      )
    : Result.ok();
};

const requireConfig = (
  config: ReviewAccountConfig,
): Result<
  { email: string; organizationId: string },
  ReviewAccountCommandError
> =>
  config.email === undefined || config.organizationId === undefined
    ? Result.err(
        new ReviewAccountCommandError({
          code: "not-configured",
          message:
            "Set APP_REVIEW_ACCOUNT_EMAIL and APP_REVIEW_ORGANIZATION_ID first.",
        }),
      )
    : Result.ok({
        email: normalize(config.email),
        organizationId: config.organizationId,
      });

type ProvisionOutcome = {
  outcome: "provisioned";
  user: "created" | "existing";
  organization: "created" | "existing";
  membership: "created" | "existing";
  verificationsRevoked: number;
};

export const provisionReviewAccount = async ({
  config,
  demoEmail,
  store,
}: {
  config: ReviewAccountConfig;
  demoEmail: string | undefined;
  store: ReviewAccountStore;
}): Promise<Result<ProvisionOutcome, ReviewAccountCommandError>> => {
  const configured = requireConfig(config);
  if (Result.isError(configured)) {
    return configured;
  }
  const { email, organizationId } = configured.value;
  if (demoEmail !== undefined && normalize(demoEmail) === email) {
    return Result.err(
      new ReviewAccountCommandError({
        code: "demo-account",
        message: "The review account must not be the demo account.",
      }),
    );
  }
  const memberUserIds = (await store.organizationExists(organizationId))
    ? await store.listMemberUserIds(organizationId)
    : null;
  const existingUserId = await store.findUserIdByEmail(email);
  if (existingUserId !== null) {
    const existing = await checkExistingAccount({
      organizationId,
      store,
      userId: existingUserId,
    });
    if (Result.isError(existing)) {
      return existing;
    }
  }
  if (memberUserIds?.some((userId) => userId !== existingUserId) === true) {
    return Result.err(
      new ReviewAccountCommandError({
        code: "organization-has-other-members",
        message:
          "The configured organization has other members; it must hold only the review account.",
      }),
    );
  }
  const userId = existingUserId ?? (await store.createUser(email));
  // Tokens and codes issued before the account was restricted must not be
  // redeemable afterwards.
  const verificationsRevoked =
    existingUserId === null
      ? 0
      : await store.revokeVerifications({ userId, email });
  if (memberUserIds === null) {
    await store.createOrganization({ organizationId, ownerUserId: userId });
    return Result.ok({
      outcome: "provisioned",
      user: existingUserId === null ? "created" : "existing",
      organization: "created",
      membership: "created",
      verificationsRevoked,
    });
  }
  const isMember = memberUserIds.includes(userId);
  if (!isMember) {
    await store.addOwner({ organizationId, userId });
  }
  return Result.ok({
    outcome: "provisioned",
    user: existingUserId === null ? "created" : "existing",
    organization: "existing",
    membership: isMember ? "existing" : "created",
    verificationsRevoked,
  });
};

type SetPasswordOutcome = {
  outcome: "password-set";
  sessionsRevoked: number;
  verificationsRevoked: number;
};

export const setReviewAccountPassword = async ({
  config,
  password,
  store,
}: {
  config: ReviewAccountConfig;
  password: string;
  store: ReviewAccountStore;
}): Promise<Result<SetPasswordOutcome, ReviewAccountCommandError>> => {
  const configured = requireConfig(config);
  if (Result.isError(configured)) {
    return configured;
  }
  // Messages state the rule, never anything about the value given.
  if (password.length < REVIEW_PASSWORD_MIN_LENGTH) {
    return Result.err(
      new ReviewAccountCommandError({
        code: "password-too-short",
        message: `The password must have at least ${REVIEW_PASSWORD_MIN_LENGTH} characters.`,
      }),
    );
  }
  if (password.length > REVIEW_PASSWORD_MAX_LENGTH) {
    return Result.err(
      new ReviewAccountCommandError({
        code: "password-too-long",
        message: `The password must have at most ${REVIEW_PASSWORD_MAX_LENGTH} characters.`,
      }),
    );
  }
  const userId = await store.findUserIdByEmail(configured.value.email);
  if (userId === null) {
    return Result.err(
      new ReviewAccountCommandError({
        code: "account-missing",
        message: "Run provision before setting the password.",
      }),
    );
  }
  if (await store.hasTwoFactorEnabled(userId)) {
    return twoFactorRefusal();
  }
  await store.setPassword({ userId, password });
  const sessionsRevoked = await store.revokeSessions(userId);
  // A reset token or code issued earlier must not undo this password.
  const verificationsRevoked = await store.revokeVerifications({
    userId,
    email: configured.value.email,
  });
  return Result.ok({
    outcome: "password-set",
    sessionsRevoked,
    verificationsRevoked,
  });
};

const decodeSecret = (
  bytes: number[],
  unreadable: () => Result<string, ReviewAccountCommandError>,
): Result<string, ReviewAccountCommandError> => {
  const decoded = Result.try(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)),
  );
  return Result.isError(decoded) || decoded.value.length === 0
    ? unreadable()
    : Result.ok(decoded.value);
};

/**
 * Reads one line from standard input: up to the first line break, Ctrl-C
 * aborts. Works for a pipe and for a terminal in raw mode (no echo).
 */
export const readSecretLine = async (
  input: AsyncIterable<Uint8Array>,
): Promise<Result<string, ReviewAccountCommandError>> => {
  const unreadable = () =>
    Result.err(
      new ReviewAccountCommandError({
        code: "password-unreadable",
        message: "Provide the password on standard input.",
      }),
    );
  const bytes: number[] = [];
  for await (const chunk of input) {
    for (const byte of chunk) {
      if (byte === 0x03) {
        return unreadable();
      }
      if (byte === 0x0a || byte === 0x0d) {
        return decodeSecret(bytes, unreadable);
      }
      bytes.push(byte);
      if (bytes.length > STDIN_MAX_BYTES) {
        return unreadable();
      }
    }
  }
  return decodeSecret(bytes, unreadable);
};

const USAGE = "Usage: review-account.js <provision|set-password>";

type CommandIo = {
  /** Standard input, read only by `set-password`. */
  stdin: () => AsyncIterable<Uint8Array>;
  writeOut: (line: string) => void;
  writeErr: (line: string) => void;
};

/** Runs one command; returns the process exit code. */
export const runReviewAccountCommand = async ({
  argv,
  config,
  demoEmail,
  io,
  store,
}: {
  argv: readonly string[];
  config: ReviewAccountConfig;
  demoEmail: string | undefined;
  io: CommandIo;
  store: () => Promise<ReviewAccountStore>;
}): Promise<number> => {
  const report = (
    result: Result<object, ReviewAccountCommandError>,
  ): number => {
    if (Result.isError(result)) {
      io.writeErr(
        JSON.stringify({
          outcome: "refused",
          code: result.error.code,
          message: result.error.message,
        }),
      );
      return 1;
    }
    io.writeOut(JSON.stringify(result.value));
    return 0;
  };
  const [command, ...rest] = argv;
  if (rest.length > 0) {
    // A password passed as an argument would already sit in the process list.
    io.writeErr(USAGE);
    return 2;
  }
  if (command === "provision") {
    return report(
      await provisionReviewAccount({
        config,
        demoEmail,
        store: await store(),
      }),
    );
  }
  if (command === "set-password") {
    const password = await readSecretLine(io.stdin());
    if (Result.isError(password)) {
      return report(password);
    }
    return report(
      await setReviewAccountPassword({
        config,
        password: password.value,
        store: await store(),
      }),
    );
  }
  io.writeErr(USAGE);
  return 2;
};
