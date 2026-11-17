import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization } from "better-auth/plugins";
import { expect, test } from "bun:test";

import { getAuth } from "@/api/lib/auth";

test("organization creation is unavailable over plugin HTTP while its server API remains usable", async () => {
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "organization-create-http-test-secret-that-is-long-enough",
    disabledPaths: getAuth().options.disabledPaths,
    database: memoryAdapter({
      user: [],
      account: [],
      verification: [],
      session: [],
      organization: [],
      member: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [organization()],
  });
  const {
    headers,
    response: { user },
  } = await auth.api.signUpEmail({
    body: {
      email: "organization-create@example.test",
      name: "Owner",
      password: "organization-create-fixture-password",
    },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((value) => value.split(";").at(0))
    .join("; ");
  const body = {
    name: "Server-created organization",
    slug: "server-created-organization",
    userId: user.id,
    keepCurrentActiveOrganization: true,
  };
  const response = await auth.handler(
    new Request("http://localhost:3001/api/auth/organization/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3001",
        cookie,
      },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(404);
  const created = await auth.api.createOrganization({ body });
  expect(created).toMatchObject({ name: body.name, slug: body.slug });
});
