import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth-paths";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  OAUTH_CLIENT_REGISTRATION_FIXTURES,
  OAUTH_CLIENT_REGISTRATION_REJECTION_FIXTURES,
} from "@/api/tests/helpers/oauth-client-registration-fixtures";

beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

/**
 * Better Auth buckets the registration rate limit per client address
 * (`${ip}|${path}`) and the provider allows a handful per minute, which a
 * census exceeds. Each fixture therefore registers from its own RFC 5737
 * documentation address, which is also what distinct clients do.
 */
let registrationsIssued = 0;
const registerClient = async (body: Record<string, unknown>) => {
  registrationsIssued += 1;
  return await getAuth().handler(
    new Request(getAuthEndpointUrl("oauth2/register"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${String(registrationsIssued)}`,
      },
      body: JSON.stringify(body),
    }),
  );
};

const registrationResponseSchema = v.looseObject({
  client_id: v.pipe(v.string(), v.minLength(1)),
});

const registrationErrorSchema = v.looseObject({ error: v.string() });

/**
 * RFC 7591 §3.2.1: the response restates the metadata the server accepted, so
 * a client-supplied value here must survive registration unaltered. `scope` is
 * excluded because the response carries the operator-approved capability set
 * rather than the requested subset, and `contacts` because an empty array is
 * normalized away.
 */
const ECHOED_METADATA_FIELDS: ReadonlySet<string> = new Set([
  "application_type",
  "client_name",
  "client_uri",
  "grant_types",
  "logo_uri",
  "policy_uri",
  "redirect_uris",
  "response_types",
  "software_id",
  "software_version",
  "token_endpoint_auth_method",
  "tos_uri",
]);

const acceptanceCases = Object.values(OAUTH_CLIENT_REGISTRATION_FIXTURES).map(
  (fixture) => [`${fixture.client} [${fixture.origin}]`, fixture] as const,
);

describe("OAuth dynamic client registration", () => {
  test.each(acceptanceCases)("registers %s", async (_label, fixture) => {
    const response = await registerClient(fixture.body);

    expect(
      response.status,
      `${fixture.client} was refused: ${await response.clone().text()}`,
    ).toBe(201);

    const registered = v.parse(
      registrationResponseSchema,
      await response.json(),
    );

    const echoed = Object.entries(fixture.body).filter(([field]) =>
      ECHOED_METADATA_FIELDS.has(field),
    );
    // A fixture that echoes nothing would assert nothing.
    expect(echoed.length).toBeGreaterThan(0);

    for (const [field, sent] of echoed) {
      expect(registered[field], `${fixture.client} altered ${field}`).toEqual(
        sent,
      );
    }
  });

  test("treats an empty contacts array as absent", async () => {
    const { body } = OAUTH_CLIENT_REGISTRATION_FIXTURES.emptyContacts;
    // The fixture must actually carry the empty array, or this passes without
    // ever reaching the normalization.
    expect(body.contacts).toEqual([]);

    const response = await registerClient(body);

    expect(response.status).toBe(201);
    const registered = v.parse(
      registrationResponseSchema,
      await response.json(),
    );
    expect(registered).not.toHaveProperty("contacts");
  });

  test("ignores unknown top-level client metadata", async () => {
    const { body } = OAUTH_CLIENT_REGISTRATION_FIXTURES.unknownMetadataFields;
    const unknownFields = ["x-vendor-deployment", "unknown_extension_field"];
    for (const field of unknownFields) {
      expect(body).toHaveProperty(field);
    }

    const response = await registerClient(body);

    expect(response.status).toBe(201);
    const registered = v.parse(
      registrationResponseSchema,
      await response.json(),
    );
    for (const field of unknownFields) {
      expect(registered).not.toHaveProperty(field);
    }
    // Registered-but-unmodelled metadata is kept, so "ignore the unknown" did
    // not become "drop everything the core schema does not map".
    expect(registered["software_id"]).toBe(body.software_id);
    expect(registered["software_version"]).toBe(body.software_version);
  });

  test("issues a client secret to a registrar that states no auth method", async () => {
    const { body } =
      OAUTH_CLIENT_REGISTRATION_FIXTURES.microsoftEnterpriseTokenStore;
    // The default only applies while the request stays silent about it.
    expect(body).not.toHaveProperty("token_endpoint_auth_method");

    const response = await registerClient(body);

    expect(response.status).toBe(201);
    const registered = v.parse(
      v.looseObject({
        client_id: v.pipe(v.string(), v.minLength(1)),
        client_secret: v.pipe(v.string(), v.minLength(1)),
        token_endpoint_auth_method: v.literal("client_secret_basic"),
      }),
      await response.json(),
    );
    expect(registered.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  test.each(
    Object.values(OAUTH_CLIENT_REGISTRATION_REJECTION_FIXTURES).map(
      (fixture) => [fixture.client, fixture] as const,
    ),
  )("refuses %s", async (_label, fixture) => {
    const response = await registerClient(fixture.body);

    expect(response.status).toBe(400);
    const refused = v.parse(registrationErrorSchema, await response.json());
    expect(refused.error).toBe(fixture.error);
  });
});
