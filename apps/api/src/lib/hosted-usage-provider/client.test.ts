import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import {
  createHostedManagementSession,
  createHostedSetupSession,
  createPolarManagementSession,
  createPolarSetupSession,
  HostedUsageProviderApiError,
} from "@/api/lib/hosted-usage-provider/client";
import { POLAR_API_VERSIONS } from "@/api/lib/hosted-usage-provider/polar/contract";

const credentials = {
  apiKey: "provider_test_apikey",
  baseUrl: "https://sandbox.provider.test",
};

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const urlToString = (url: string | URL | Request | undefined): string => {
  if (typeof url === "string") {
    return url;
  }
  if (url instanceof URL) {
    return url.href;
  }
  if (url instanceof Request) {
    return url.url;
  }
  throw new Error("fetch URL was not captured");
};

const readJsonRequestBody = (
  body: RequestInit["body"],
): Record<string, unknown> => {
  if (typeof body !== "string") {
    throw new TypeError("request body was not a JSON string");
  }
  const parsed = JSON.parse(body);
  if (!isRecord(parsed)) {
    throw new Error("request body was not an object");
  }
  return parsed;
};

let originalFetch: typeof globalThis.fetch;

type FetchHandler = (
  ...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

const installFetch = (handler: FetchHandler): void => {
  const nextFetch: typeof globalThis.fetch = Object.assign(handler, {
    preconnect: originalFetch.preconnect,
  });
  globalThis.fetch = nextFetch;
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createHostedSetupSession", () => {
  test("POSTs to /v1/setup-sessions with credentials, policy_refs array, metadata", async () => {
    let callCount = 0;
    let calledUrl: string | URL | Request | undefined;
    let calledInit: RequestInit | undefined;
    installFetch(async (url, init) => {
      callCount += 1;
      calledUrl = url;
      calledInit = init;
      return okResponse({
        id: "provider_setup_abc",
        url: "https://setup.provider.test/abc",
      });
    });

    const result = await createHostedSetupSession({
      credentials,
      policyRef: "provider_policy_pro",
      externalAccountRef: "stella_org_org_test_001",
      successUrl: "https://app.stella.test/settings",
      returnUrl: "https://app.stella.test/settings/organization/usage",
      metadata: {
        organization_id: "org_test_001",
        usage_policy_id: "plan_test_001",
        seat_user_id: "user_test_001",
      },
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.id).toBe("provider_setup_abc");
      expect(result.value.url).toBe("https://setup.provider.test/abc");
      expect(result.value.expiresAt).toBeNull();
    }
    expect(callCount).toBe(1);
    expect(urlToString(calledUrl)).toBe(
      "https://sandbox.provider.test/v1/setup-sessions/",
    );
    expect(calledInit?.method).toBe("POST");
    const headers = new Headers(calledInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer provider_test_apikey");
    const body = readJsonRequestBody(calledInit?.body);
    expect(body["policy_refs"]).toEqual(["provider_policy_pro"]);
    expect(body["success_url"]).toBe("https://app.stella.test/settings");
    expect(body["return_url"]).toBe(
      "https://app.stella.test/settings/organization/usage",
    );
    expect(body["external_account_ref"]).toBe("stella_org_org_test_001");
    expect("account_ref" in body).toBe(false);
    const metadata = body["metadata"];
    if (!isRecord(metadata)) {
      throw new Error("metadata was not an object");
    }
    expect(metadata["organization_id"]).toBe("org_test_001");
  });

  test("prefills an existing hosted account when account_ref is known", async () => {
    let calledInit: RequestInit | undefined;
    installFetch(async (_url, init) => {
      calledInit = init;
      return okResponse({
        id: "provider_setup_existing",
        url: "https://setup.provider.test/existing",
      });
    });

    const result = await createHostedSetupSession({
      credentials,
      policyRef: "provider_policy_pro",
      accountRef: "acct_existing",
      successUrl: "https://app.stella.test/settings",
      metadata: {
        organization_id: "org_test_existing",
        usage_policy_id: "policy_test_existing",
      },
    });

    expect(Result.isOk(result)).toBe(true);
    const body = readJsonRequestBody(calledInit?.body);
    expect(body["account_ref"]).toBe("acct_existing");
    expect("external_account_ref" in body).toBe(false);
  });

  test("surfaces non-2xx as HostedUsageProviderApiError", async () => {
    installFetch(
      async () =>
        new Response("server exploded", {
          status: 500,
        }),
    );

    const result = await createHostedSetupSession({
      credentials,
      policyRef: "provider_policy_pro",
      successUrl: "https://app.stella.test/settings",
      metadata: {
        organization_id: "org_test_002",
        usage_policy_id: "plan_test_002",
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(HostedUsageProviderApiError.is(result.error)).toBe(true);
      expect(result.error.status).toBe(500);
    }
  });

  test("network failure surfaces as HostedUsageProviderApiError with original cause", async () => {
    installFetch(async () => {
      throw new Error("ECONNRESET");
    });

    const result = await createHostedSetupSession({
      credentials,
      policyRef: "provider_policy_pro",
      successUrl: "https://app.stella.test/settings",
      metadata: {
        organization_id: "org_test_003",
        usage_policy_id: "plan_test_003",
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(HostedUsageProviderApiError.is(result.error)).toBe(true);
    }
  });
});

describe("createHostedManagementSession", () => {
  test("POSTs the account_ref and return_url to management sessions", async () => {
    let callCount = 0;
    let calledUrl: string | URL | Request | undefined;
    let calledInit: RequestInit | undefined;
    installFetch(async (url, init) => {
      callCount += 1;
      calledUrl = url;
      calledInit = init;
      return okResponse({
        management_url: "https://manage.provider.test/acct_test_xxx",
      });
    });

    const result = await createHostedManagementSession({
      credentials,
      accountRef: "acct_test_xxx",
      returnUrl: "https://app.stella.test/settings/organization/usage",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.url).toBe(
        "https://manage.provider.test/acct_test_xxx",
      );
    }
    expect(callCount).toBe(1);
    expect(urlToString(calledUrl)).toBe(
      "https://sandbox.provider.test/v1/management-sessions",
    );
    const body = readJsonRequestBody(calledInit?.body);
    expect(body["account_ref"]).toBe("acct_test_xxx");
    expect(body["return_url"]).toBe(
      "https://app.stella.test/settings/organization/usage",
    );
  });

  test("404 from provider surfaces as HostedUsageProviderApiError", async () => {
    installFetch(async () => new Response("not found", { status: 404 }));

    const result = await createHostedManagementSession({
      credentials,
      accountRef: "acct_missing",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(404);
    }
  });
});

describe("createPolarSetupSession", () => {
  test.each([{ expires_at: "not a timestamp" }, { expires_at: 1_780_000_000 }])(
    "refuses a session with an unreadable expiry ($expires_at)",
    async ({ expires_at }) => {
      installFetch(async () =>
        okResponse({
          id: "checkout_bad_expiry",
          url: "https://buy.polar.test/bad",
          expires_at,
        }),
      );

      const result = await createPolarSetupSession({
        credentials,
        policyRef: "prod_pro",
        externalAccountRef: "stella_org_org_test_001",
        successUrl: "https://app.stella.test/settings",
        metadata: {
          organization_id: "org_test_001",
          usage_policy_id: "plan_test_001",
        },
      });

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(HostedUsageProviderApiError.is(result.error)).toBe(true);
        expect(result.error.message).toBe("Hosted setup session failed");
      }
    },
  );

  test("POSTs to /v1/checkouts/ with products array and external_customer_id", async () => {
    let calledUrl: string | URL | Request | undefined;
    let calledInit: RequestInit | undefined;
    installFetch(async (url, init) => {
      calledUrl = url;
      calledInit = init;
      return okResponse({
        id: "checkout_abc",
        url: "https://buy.polar.test/abc",
        client_secret: "cs_x",
        expires_at: "2026-06-01T01:00:00Z",
      });
    });

    const result = await createPolarSetupSession({
      credentials,
      policyRef: "prod_pro",
      externalAccountRef: "stella_org_org_test_001",
      successUrl: "https://app.stella.test/settings",
      returnUrl: "https://app.stella.test/settings/organization/usage",
      metadata: {
        organization_id: "org_test_001",
        usage_policy_id: "plan_test_001",
      },
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.id).toBe("checkout_abc");
      expect(result.value.url).toBe("https://buy.polar.test/abc");
      expect(result.value.expiresAt).toEqual(new Date("2026-06-01T01:00:00Z"));
    }
    expect(urlToString(calledUrl)).toBe(
      "https://sandbox.provider.test/v1/checkouts/",
    );
    const body = readJsonRequestBody(calledInit?.body);
    expect(body["products"]).toEqual(["prod_pro"]);
    expect(body["external_customer_id"]).toBe("stella_org_org_test_001");
    expect(body["success_url"]).toBe("https://app.stella.test/settings");
    // The Polar request body must not leak the neutral contract's field names.
    expect("policy_refs" in body).toBe(false);
    expect("account_ref" in body).toBe(false);
    // Every checkout is a business purchase; Polar's form collects the tax
    // id, so none is preset.
    expect(body["is_business_customer"]).toBe(true);
    expect("customer_tax_id" in body).toBe(false);
  });

  test("surfaces non-2xx as HostedUsageProviderApiError", async () => {
    installFetch(async () => new Response("unprocessable", { status: 422 }));

    const result = await createPolarSetupSession({
      credentials,
      policyRef: "prod_pro",
      externalAccountRef: "stella_org_x",
      successUrl: "https://app.stella.test/settings",
      metadata: { organization_id: "org", usage_policy_id: "pol" },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(422);
    }
  });
});

describe("createPolarManagementSession", () => {
  test("POSTs customer_id to /v1/customer-sessions/ and reads customer_portal_url", async () => {
    let calledUrl: string | URL | Request | undefined;
    let calledInit: RequestInit | undefined;
    installFetch(async (url, init) => {
      calledUrl = url;
      calledInit = init;
      return okResponse({
        token: "tok_x",
        customer_portal_url: "https://portal.polar.test/cus_abc",
      });
    });

    const result = await createPolarManagementSession({
      credentials,
      accountRef: "cus_abc",
      returnUrl: "https://app.stella.test/settings/organization/usage",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.url).toBe("https://portal.polar.test/cus_abc");
    }
    expect(urlToString(calledUrl)).toBe(
      "https://sandbox.provider.test/v1/customer-sessions/",
    );
    const body = readJsonRequestBody(calledInit?.body);
    expect(body["customer_id"]).toBe("cus_abc");
    expect(body["return_url"]).toBe(
      "https://app.stella.test/settings/organization/usage",
    );
  });
});

describe("outbound version contract", () => {
  for (const version of POLAR_API_VERSIONS) {
    test(`every endpoint carries configured version ${version}`, async () => {
      const previousVersion = env.HOSTED_USAGE_PROVIDER_API_VERSION;
      env.HOSTED_USAGE_PROVIDER_API_VERSION = version;
      const observed: (string | null)[] = [];
      installFetch(async (_url, init) => {
        const headers = new Headers(init?.headers);
        observed.push(headers.get("Polar-Version"));
        return okResponse({
          id: "session",
          url: "https://provider.test/session",
          management_url: "https://provider.test/session",
          customer_portal_url: "https://provider.test/session",
        });
      });
      try {
        const setup = {
          credentials,
          policyRef: "policy_ref",
          successUrl: "https://app.test/return",
          metadata: {
            organization_id: "org_fixture",
            usage_policy_id: "policy_fixture",
          },
        };
        const management = { credentials, accountRef: "account_ref" };
        for (const result of [
          await createHostedSetupSession(setup),
          await createPolarSetupSession(setup),
          await createHostedManagementSession(management),
          await createPolarManagementSession(management),
        ]) {
          expect(Result.isOk(result)).toBe(true);
        }
        expect(observed).toEqual([version, version, version, version]);
      } finally {
        env.HOSTED_USAGE_PROVIDER_API_VERSION = previousVersion;
      }
    });
  }
});
