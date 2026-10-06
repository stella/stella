import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { twoFactor } from "better-auth/plugins";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import type { LogRecord } from "@/api/lib/observability/logger";
import {
  createReviewAccountAuthStore,
  provisionReviewAccount,
  readSecretLine,
  REVIEW_PASSWORD_MIN_LENGTH,
  runReviewAccountCommand,
} from "@/api/scripts/review-account.logic";
import type { ReviewAccountStore } from "@/api/scripts/review-account.logic";

const reviewEmail = "review@example.test";
const organizationId = "org_review";
const config = { email: reviewEmail, organizationId };
const password = "fixture password that is long enough";
const nextPassword = "another fixture password, also long";

const chunks = (...parts: string[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const part of parts) {
      yield new TextEncoder().encode(part);
    }
  },
});

/** Organizations and memberships in memory; accounts from `accounts`. */
const createFakeStore = (
  accounts: Pick<
    ReviewAccountStore,
    | "findUserIdByEmail"
    | "hasTwoFactorEnabled"
    | "createUser"
    | "setPassword"
    | "revokeSessions"
    | "revokeVerifications"
  >,
) => {
  const organizations = new Map<string, string[]>();
  const writes: string[] = [];
  const store: ReviewAccountStore = {
    ...accounts,
    createUser: async (email) => {
      writes.push("user");
      return await accounts.createUser(email);
    },
    organizationExists: async (id) => organizations.has(id),
    listMemberUserIds: async (id) => [...(organizations.get(id) ?? [])],
    listOrganizationIdsForUser: async (userId) =>
      [...organizations].flatMap(([id, members]) =>
        members.includes(userId) ? [id] : [],
      ),
    createOrganization: async ({ organizationId: id, ownerUserId }) => {
      writes.push("organization");
      organizations.set(id, [ownerUserId]);
    },
    addOwner: async ({ organizationId: id, userId }) => {
      writes.push("membership");
      organizations.set(id, [...(organizations.get(id) ?? []), userId]);
    },
  };
  return { organizations, store, writes };
};

const createMemoryAccounts = () => {
  const users = new Map<string, string>();
  return {
    users,
    accounts: {
      findUserIdByEmail: async (email: string) => users.get(email) ?? null,
      hasTwoFactorEnabled: async () => false,
      createUser: async (email: string) => {
        const id = `user_${users.size + 1}`;
        users.set(email, id);
        return id;
      },
      setPassword: async () => undefined,
      revokeSessions: async () => 0,
      revokeVerifications: async () => 0,
    },
  };
};

describe("review account provisioning", () => {
  test("creates the account, organization and owner once", async () => {
    const { accounts } = createMemoryAccounts();
    const { organizations, store, writes } = createFakeStore(accounts);
    const first = await provisionReviewAccount({
      config,
      demoEmail: "limited@example.test",
      store,
    });
    expect(first).toEqual(
      Result.ok({
        outcome: "provisioned",
        user: "created",
        organization: "created",
        membership: "created",
        verificationsRevoked: 0,
      }),
    );
    const second = await provisionReviewAccount({
      config: { ...config, email: " Review@Example.Test " },
      demoEmail: "limited@example.test",
      store,
    });
    expect(second).toEqual(
      Result.ok({
        outcome: "provisioned",
        user: "existing",
        organization: "existing",
        membership: "existing",
        verificationsRevoked: 0,
      }),
    );
    expect(writes).toEqual(["user", "organization"]);
    expect(organizations.get(organizationId)).toEqual(["user_1"]);
  });

  test("adds the owner to an existing empty organization", async () => {
    const { accounts } = createMemoryAccounts();
    const { organizations, store, writes } = createFakeStore(accounts);
    organizations.set(organizationId, []);
    const result = await provisionReviewAccount({
      config,
      demoEmail: undefined,
      store,
    });
    expect(result).toMatchObject({
      value: { organization: "existing", membership: "created" },
    });
    expect(writes).toEqual(["user", "membership"]);
  });

  test("refuses an organization with other members and writes nothing", async () => {
    const { accounts } = createMemoryAccounts();
    const { organizations, store, writes } = createFakeStore(accounts);
    organizations.set(organizationId, ["user_someone_else"]);
    const result = await provisionReviewAccount({
      config,
      demoEmail: undefined,
      store,
    });
    expect(Result.isError(result) && result.error.code).toBe(
      "organization-has-other-members",
    );
    expect(writes).toEqual([]);
  });

  test("refuses an account that belongs to another organization", async () => {
    const { accounts } = createMemoryAccounts();
    const { organizations, store, writes } = createFakeStore(accounts);
    const userId = await accounts.createUser(reviewEmail);
    organizations.set("org_elsewhere", [userId]);
    for (const existing of [false, true]) {
      if (existing) {
        organizations.set(organizationId, [userId]);
      }
      const result = await provisionReviewAccount({
        config,
        demoEmail: undefined,
        store,
      });
      expect(Result.isError(result) && result.error.code).toBe(
        "account-in-other-organization",
      );
    }
    expect(writes).toEqual([]);
  });

  test("refuses the demo address and an incomplete configuration", async () => {
    const { accounts } = createMemoryAccounts();
    const { store, writes } = createFakeStore(accounts);
    const demo = await provisionReviewAccount({
      config,
      demoEmail: "REVIEW@example.test",
      store,
    });
    expect(Result.isError(demo) && demo.error.code).toBe("demo-account");
    for (const partial of [
      { email: undefined, organizationId },
      { email: reviewEmail, organizationId: undefined },
    ]) {
      const result = await provisionReviewAccount({
        config: partial,
        demoEmail: undefined,
        store,
      });
      expect(Result.isError(result) && result.error.code).toBe(
        "not-configured",
      );
    }
    expect(writes).toEqual([]);
  });
});

describe("reading the password", () => {
  test.each([
    [["secret line\n"], "secret line"],
    [["secret ", "line\r\n", "ignored"], "secret line"],
    [["secret line"], "secret line"],
  ])("reads one line from %p", async (parts, expected) => {
    expect(await readSecretLine(chunks(...parts))).toEqual(Result.ok(expected));
  });

  test.each([[[]], [["\n"]], [["abc\u0003"]], [["x".repeat(5000)]]])(
    "refuses empty, interrupted or oversized input %#",
    async (parts) => {
      const read = await readSecretLine(chunks(...parts));
      expect(Result.isError(read) && read.error.code).toBe(
        "password-unreadable",
      );
    },
  );
});

const createPasswordAuth = async () => {
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      twoFactor: [],
    }),
    emailAndPassword: { enabled: true, disableSignUp: true },
    plugins: [twoFactor({ allowPasswordless: true })],
  });
  return { auth, context: await auth.$context };
};

const signIn = async (
  auth: Awaited<ReturnType<typeof createPasswordAuth>>["auth"],
  candidate: string,
) =>
  await auth.api.signInEmail({
    body: { email: reviewEmail, password: candidate },
    asResponse: true,
  });

const runCommand = async ({
  argv,
  input,
  store,
}: {
  argv: string[];
  input: string;
  store: ReviewAccountStore;
}) => {
  const out: string[] = [];
  const err: string[] = [];
  const logs: LogRecord[] = [];
  setLogSinkForTesting((record) => {
    logs.push(record);
  });
  try {
    const code = await runReviewAccountCommand({
      argv,
      config,
      demoEmail: undefined,
      io: {
        stdin: () => chunks(input),
        writeOut: (line) => {
          out.push(line);
        },
        writeErr: (line) => {
          err.push(line);
        },
      },
      store: async () => store,
    });
    return { code, out, err, transcript: JSON.stringify([out, err, logs]) };
  } finally {
    resetLogSinkForTesting();
  }
};

describe("review account password command", () => {
  test("sets the password through Better Auth and ends existing sessions", async () => {
    const { auth, context } = await createPasswordAuth();
    const { store } = createFakeStore(createReviewAccountAuthStore(context));

    const provisioned = await runCommand({
      argv: ["provision"],
      input: "",
      store,
    });
    expect(provisioned.code).toBe(0);

    const first = await runCommand({
      argv: ["set-password"],
      input: `${password}\n`,
      store,
    });
    expect(first.out).toEqual([
      JSON.stringify({
        outcome: "password-set",
        sessionsRevoked: 0,
        verificationsRevoked: 0,
      }),
    ]);
    expect(first.transcript).not.toContain(password);
    expect((await signIn(auth, password)).status).toBe(200);

    // Rotation: the open session ends, earlier reset tokens and emailed codes
    // are deleted, the new password works, the old one fails.
    const userId =
      (await context.internalAdapter.findUserByEmail(reviewEmail))?.user.id ??
      "";
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await context.internalAdapter.createVerificationValue({
      identifier: "reset-password:earlier-token",
      value: userId,
      expiresAt,
    });
    await context.internalAdapter.createVerificationValue({
      identifier: `forget-password-otp-${reviewEmail}`,
      value: "123456:0",
      expiresAt,
    });
    // Codes of other accounts, including one whose address extends the
    // review address, and the review account's own sign-in code.
    const kept = [
      "sign-in-otp-member@example.test",
      `sign-in-otp-${reviewEmail}.extended`,
      `forget-password-otp-x${reviewEmail}`,
    ];
    for (const identifier of [`sign-in-otp-${reviewEmail}`, ...kept]) {
      await context.internalAdapter.createVerificationValue({
        identifier,
        value: "654321:0",
        expiresAt,
      });
    }
    const rotated = await runCommand({
      argv: ["set-password"],
      input: `${nextPassword}\n`,
      store,
    });
    expect(rotated.out).toEqual([
      JSON.stringify({
        outcome: "password-set",
        sessionsRevoked: 1,
        verificationsRevoked: 3,
      }),
    ]);
    expect(rotated.transcript).not.toContain(nextPassword);
    expect(
      await context.internalAdapter.findVerificationValue(
        "reset-password:earlier-token",
      ),
    ).toBeNull();
    expect(
      await context.internalAdapter.findVerificationValue(
        `forget-password-otp-${reviewEmail}`,
      ),
    ).toBeNull();
    expect(
      await context.internalAdapter.findVerificationValue(
        `sign-in-otp-${reviewEmail}`,
      ),
    ).toBeNull();
    // Other accounts' codes are untouched, even where the address extends it.
    for (const identifier of kept) {
      expect(
        await context.internalAdapter.findVerificationValue(identifier),
      ).not.toBeNull();
    }
    expect(
      await context.internalAdapter.listSessions(
        (await context.internalAdapter.findUserByEmail(reviewEmail))?.user.id ??
          "",
      ),
    ).toEqual([]);
    expect((await signIn(auth, password)).status).toBe(401);
    expect((await signIn(auth, nextPassword)).status).toBe(200);
    // Stored only as Better Auth's hash.
    const stored = (
      await context.internalAdapter.findAccounts(
        (await context.internalAdapter.findUserByEmail(reviewEmail))?.user.id ??
          "",
      )
    ).find((account) => account.providerId === "credential")?.password;
    expect(stored).toBeDefined();
    expect(stored).not.toContain(nextPassword);
  });

  test("refuses a short password without repeating it", async () => {
    const { context } = await createPasswordAuth();
    const { store } = createFakeStore(createReviewAccountAuthStore(context));
    await runCommand({ argv: ["provision"], input: "", store });
    const short = "x".repeat(REVIEW_PASSWORD_MIN_LENGTH - 1);
    const result = await runCommand({
      argv: ["set-password"],
      input: `${short}\n`,
      store,
    });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("")).toContain('"code":"password-too-short"');
    expect(result.transcript).not.toContain(short);
  });

  test("refuses a password given as an argument and before provisioning", async () => {
    const { context } = await createPasswordAuth();
    const { store, writes } = createFakeStore(
      createReviewAccountAuthStore(context),
    );
    const asArgument = await runCommand({
      argv: ["set-password", password],
      input: "",
      store,
    });
    expect(asArgument.code).toBe(2);
    expect(asArgument.transcript).not.toContain(password);

    const missing = await runCommand({
      argv: ["set-password"],
      input: `${password}\n`,
      store,
    });
    expect(missing.code).toBe(1);
    expect(missing.err.join("")).toContain('"code":"account-missing"');
    expect(missing.transcript).not.toContain(password);
    expect(writes).toEqual([]);
  });

  test("refuses an account with two-factor authentication enabled", async () => {
    const { context } = await createPasswordAuth();
    const { store, writes } = createFakeStore(
      createReviewAccountAuthStore(context),
    );
    // An account already enrolled before it was chosen as the review account.
    await context.internalAdapter.createUser(
      {
        email: reviewEmail,
        name: "Enrolled",
        emailVerified: true,
        twoFactorEnabled: true,
      },
      { method: "admin" },
    );
    for (const argv of [["provision"], ["set-password"]]) {
      const result = await runCommand({
        argv,
        input: `${password}\n`,
        store,
      });
      expect(result.code).toBe(1);
      expect(result.err.join("")).toContain('"code":"two-factor-enabled"');
      expect(result.transcript).not.toContain(password);
    }
    expect(writes).toEqual([]);
    const userId =
      (await context.internalAdapter.findUserByEmail(reviewEmail))?.user.id ??
      "";
    expect(
      (await context.internalAdapter.findAccounts(userId)).some(
        (account) => account.providerId === "credential",
      ),
    ).toBe(false);
  });
});
