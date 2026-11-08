import { afterAll, beforeAll, expect, test } from "bun:test";
import * as v from "valibot";

import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { createHumanSession } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  authorizeOAuthClient,
  OAUTH_CONSENT_PAGE_PATH,
  OAUTH_ORGANIZATION_PAGE_PATH,
  readSignedQuery,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";

beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const redirectSchema = v.looseObject({
  redirect: v.literal(true),
  url: v.string(),
});

/** What the organization page's `set-active` answers, as the browser reads it. */
const pickOrganization = async ({
  cookie,
  organizationId,
  oauthQuery,
}: {
  cookie: string;
  organizationId: string;
  oauthQuery: string;
}): Promise<{ status: number; next: URL }> => {
  const address = "198.51.100.77";
  const response = await getAuth().handler(
    new Request(getAuthEndpointUrl("organization/set-active"), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie,
        "x-forwarded-for": address,
        [AUTH_CLIENT_ADDRESS_HEADER]: address,
      },
      body: JSON.stringify({ organizationId, oauth_query: oauthQuery }),
    }),
  );
  const answer = v.parse(redirectSchema, await response.json());
  return { status: response.status, next: new URL(answer.url) };
};

test("picking an organization during an authorization moves on to consent", async () => {
  const session = await createHumanSession({
    email: `org-pick-${Bun.randomUUIDv7()}@example.test`,
    orgName: "First",
    orgSlugPrefix: "org-pick-first",
  });
  // Two memberships: the provider always asks which one the client acts in.
  const second = await getAuth().api.createOrganization({
    body: { name: "Second", slug: `org-pick-second-${Bun.randomUUIDv7()}` },
    headers: session.browser.headers(),
  });
  const client = await registerOAuthClient(undefined, "none");
  const { redirect } = await authorizeOAuthClient(session.browser, client);
  expect(redirect.pathname).toBe(OAUTH_ORGANIZATION_PAGE_PATH);

  const picked = await pickOrganization({
    cookie: session.browser.cookieHeader(),
    organizationId: second.id,
    oauthQuery: readSignedQuery(redirect),
  });
  expect(picked.status).toBe(200);
  // Not the organization page again: the browser would reload the picker it
  // just used and never reach the consent step.
  expect(picked.next.pathname).toBe(OAUTH_CONSENT_PAGE_PATH);
});
