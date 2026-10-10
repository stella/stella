import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const email = process.env["APP_REVIEW_ACCOUNT_EMAIL"];
const organizationId = process.env["APP_REVIEW_ORGANIZATION_ID"];

test("provisions one verified owner, rotates credentials, and refuses HTTP creation", async () => {
  if (!email || !organizationId) {
    panic("Isolated review account fixture is not configured");
  }
  const { getAuth } = await import("@/api/lib/auth");
  const { env } = await import("@/api/env");
  const { rootDb } = await import("@/api/db/root");
  const { user, organization, verification } =
    await import("@/api/db/auth-schema");
  const { getAuthEndpointUrl } = await import("@/api/lib/auth/auth-paths");
  const { REVIEW_ACCOUNT_REFUSAL_MESSAGE } =
    await import("@/api/lib/auth/review-account-policy");
  const { readDevOtp } = await import("@/api/lib/dev-otp-store");
  const { MCP_DEFAULT_RESOURCE_SCOPES } = await import("@stll/api-contract");
  const { getMcpResourceUrl } = await import("@/api/mcp/constants");
  const { OAUTH_CONSENT_PAGE_PATH, readOAuthRedirect, registerOAuthClient } =
    await import("@/api/tests/helpers/oauth-grant");
  const auth = getAuth();
  const context = await auth.$context;
  const config = {
    email: env.APP_REVIEW_ACCOUNT_EMAIL,
    organizationId: env.APP_REVIEW_ORGANIZATION_ID,
  };
  expect(config).toEqual({ email, organizationId });
  const runCommand = async (
    command: "provision" | "set-password",
    secret = "",
  ) => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--preload",
        "./src/tests/setup-env.ts",
        `${import.meta.dir}/../../scripts/review-account.ts`,
        command,
      ],
      env: process.env,
      stdin: new TextEncoder().encode(`${secret}\n`),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
      expect(child.signalCode, `${stdout}\n${stderr}`).toBeNull();
      return stdout.trim();
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  };
  const post = async (path: string, body: Record<string, unknown>) =>
    await auth.handler(
      new Request(getAuthEndpointUrl(path.slice(1)), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: env.FRONTEND_URL,
        },
        body: JSON.stringify(body),
      }),
    );
  const password = "review database fixture password";
  const rotatedPassword = "rotated review database fixture password";
  const ordinaryEmail = `ordinary-${Bun.randomUUIDv7()}@stella.dev`;
  try {
    const refused = await Result.tryPromise({
      try: async () =>
        await auth.api.createReviewAccountUser({
          body: { email: ordinaryEmail },
        }),
      catch: (cause) => cause,
    });
    expect(refused.isErr()).toBe(true);
    if (refused.isErr()) {
      expect(refused.error).toMatchObject({
        status: "FORBIDDEN",
        body: {
          code: "account_access_unavailable",
          message: REVIEW_ACCOUNT_REFUSAL_MESSAGE,
        },
      });
    }
    expect(
      await context.internalAdapter.findUserByEmail(ordinaryEmail),
    ).toBeNull();
    const httpCreationPaths = [
      {
        path: "/sign-up/email",
        status: 400,
        body: { message: "Self-host bootstrap is not available." },
      },
      {
        path: "/sign-in/email-otp",
        status: 403,
        body: {
          code: "account_access_unavailable",
          message: REVIEW_ACCOUNT_REFUSAL_MESSAGE,
        },
      },
    ];
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const otp = readDevOtp(email);
    if (!otp) {
      panic("Auth did not issue the fixture OTP");
    }
    for (const { path, status, body } of httpCreationPaths) {
      const response = await post(path, {
        email,
        password,
        name: "Reviewer",
        otp,
      });
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(
        status,
      );
      expect(await response.json()).toMatchObject(body);
    }
    expect((await post("/review-account/create-user", { email })).status).toBe(
      404,
    );
    expect(await context.internalAdapter.findUserByEmail(email)).toBeNull();

    expect(await runCommand("provision")).toBe(
      JSON.stringify({
        outcome: "provisioned",
        user: "created",
        organization: "created",
        membership: "created",
        verificationsRevoked: 0,
        invitationsCanceled: 0,
      }),
    );
    const created = await rootDb.query.user.findFirst({
      where: { email: { eq: email } },
    });
    if (!created) {
      panic("Provision did not persist the fixture user");
    }
    expect(created.emailVerified).toBe(true);
    const memberships = await rootDb.query.member.findMany({
      where: { userId: { eq: created.id } },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships.at(0)).toMatchObject({
      organizationId,
      role: "owner",
    });
    expect(
      await rootDb.query.member.findMany({
        where: { organizationId: { eq: organizationId } },
      }),
    ).toEqual(memberships);

    await runCommand("set-password", password);
    const accounts = await context.internalAdapter.findAccounts(created.id);
    expect(accounts).toHaveLength(1);
    const credential = accounts.at(0);
    expect(credential).toMatchObject({
      providerId: "credential",
      accountId: created.id,
      userId: created.id,
    });
    if (!credential?.password) {
      panic("Set-password did not persist a credential hash");
    }
    expect(
      await context.password.verify({ hash: credential.password, password }),
    ).toBe(true);
    expect(credential.password).not.toBe(password);
    expect(await runCommand("provision")).toBe(
      JSON.stringify({
        outcome: "provisioned",
        user: "existing",
        organization: "existing",
        membership: "existing",
        verificationsRevoked: 0,
        invitationsCanceled: 0,
      }),
    );
    expect(
      await rootDb.query.user.findMany({ where: { email: { eq: email } } }),
    ).toEqual([created]);
    expect(
      await rootDb.query.member.findMany({
        where: { organizationId: { eq: organizationId } },
      }),
    ).toEqual(memberships);
    expect(await context.internalAdapter.findAccounts(created.id)).toEqual(
      accounts,
    );

    const headers = await Promise.all(
      [0, 1].map(async () => {
        const response = await post("/sign-in/email", { email, password });
        expect(response.status, await response.clone().text()).toBe(200);
        const cookie = response.headers
          .getSetCookie()
          .map((value) => value.split(";").at(0))
          .join("; ");
        const sessionHeaders = new Headers({ cookie });
        const active = await auth.api.getSession({
          headers: sessionHeaders,
          query: { disableCookieCache: true },
        });
        expect(active?.user.id).toBe(created.id);
        expect(active?.session.activeOrganizationId).toBe(organizationId);
        return sessionHeaders;
      }),
    );
    expect(await context.internalAdapter.listSessions(created.id)).toHaveLength(
      2,
    );
    expect(await runCommand("set-password", rotatedPassword)).toBe(
      JSON.stringify({
        outcome: "password-set",
        sessionsRevoked: 2,
        verificationsRevoked: 0,
      }),
    );
    expect(await context.internalAdapter.listSessions(created.id)).toEqual([]);
    for (const sessionHeaders of headers) {
      expect(
        await auth.api.getSession({
          headers: sessionHeaders,
          query: { disableCookieCache: true },
        }),
      ).toBeNull();
    }
    expect((await post("/sign-in/email", { email, password })).status).toBe(
      401,
    );
    const rotatedSignIn = await post("/sign-in/email", {
      email,
      password: rotatedPassword,
    });
    expect(rotatedSignIn.status).toBe(200);

    // The account authorizes an MCP client for its organization: the
    // provider's organization check must not trip the account's own rules.
    const client = await registerOAuthClient();
    const authorizeUrl = new URL(getAuthEndpointUrl("oauth2/authorize"));
    authorizeUrl.search = new URLSearchParams({
      client_id: client.clientId,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      redirect_uri: "https://connector.example.test/oauth/callback",
      resource: getMcpResourceUrl(),
      response_type: "code",
      scope: MCP_DEFAULT_RESOURCE_SCOPES.join(" "),
      state: Bun.randomUUIDv7(),
    }).toString();
    const authorized = await auth.handler(
      new Request(authorizeUrl.href, {
        headers: {
          accept: "application/json",
          cookie: rotatedSignIn.headers
            .getSetCookie()
            .map((value) => value.split(";").at(0))
            .join("; "),
        },
      }),
    );
    expect(authorized.status, await authorized.clone().text()).toBe(200);
    expect((await readOAuthRedirect(authorized)).pathname).toBe(
      OAUTH_CONSENT_PAGE_PATH,
    );

    const rotatedAccounts = await context.internalAdapter.findAccounts(
      created.id,
    );
    expect(rotatedAccounts).toHaveLength(1);
    expect(rotatedAccounts.at(0)?.id).toBe(credential.id);
  } finally {
    await rootDb
      .delete(organization)
      .where(eq(organization.id, organizationId));
    await rootDb.delete(user).where(eq(user.email, email));
    await rootDb.delete(user).where(eq(user.email, ordinaryEmail));
    await rootDb
      .delete(verification)
      .where(eq(verification.identifier, `sign-in-otp-${email}`));
  }
}, 75_000);
