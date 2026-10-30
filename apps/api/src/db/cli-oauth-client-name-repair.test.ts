import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import { CLI_LOOPBACK_CLIENT_METADATA } from "@stll/cli/client-metadata-document";

import { CLI_OAUTH_CLIENT_NAME_REPAIR } from "./cli-oauth-client-name-repair";
import type { OnlineMigrationConnection } from "./online-migration-connection";

test("legacy CLI names converge across batches without changing unrelated registrations or grants", async () => {
  const database = new PGlite();
  await database.exec(`CREATE TABLE oauth_client (
    id text PRIMARY KEY, name text, application_type text,
    registration_origin text DEFAULT 'historical', client_discovery_id text,
    token_endpoint_auth_method text, grant_types text[], response_types text[],
    redirect_uris text[], updated_at timestamptz DEFAULT '2000-01-01');
    CREATE TABLE oauth_consent (id text PRIMARY KEY, client_id text REFERENCES oauth_client(id));
    CREATE TABLE oauth_refresh_token (id text PRIMARY KEY, client_id text REFERENCES oauth_client(id));`);
  const addClient = async (id: string, metadata: Record<string, unknown>) => {
    await database.query(
      `INSERT INTO oauth_client (id, name, application_type, token_endpoint_auth_method, grant_types, response_types, redirect_uris)
       SELECT $1, $2, client.application_type, client.token_endpoint_auth_method, client.grant_types, client.response_types, client.redirect_uris
       FROM jsonb_to_record($3::text::jsonb) AS client(application_type text, token_endpoint_auth_method text, grant_types text[], response_types text[], redirect_uris text[])`,
      [id, "stella-cli", JSON.stringify(metadata)],
    );
  };
  for (let index = 0; index < 201; index += 1) {
    await addClient(`cli-${String(index)}`, CLI_LOOPBACK_CLIENT_METADATA);
  }
  const unrelated = [
    { ...CLI_LOOPBACK_CLIENT_METADATA, application_type: "web" },
    {
      ...CLI_LOOPBACK_CLIENT_METADATA,
      token_endpoint_auth_method: "client_secret_post",
    },
    {
      ...CLI_LOOPBACK_CLIENT_METADATA,
      redirect_uris: ["https://unrelated.example/callback"],
    },
    {
      ...CLI_LOOPBACK_CLIENT_METADATA,
      redirect_uris: [
        "http://127.0.0.1/callback",
        "https://unrelated.example/callback",
      ],
    },
    { ...CLI_LOOPBACK_CLIENT_METADATA, grant_types: ["authorization_code"] },
    { ...CLI_LOOPBACK_CLIENT_METADATA, response_types: ["token"] },
  ];
  for (const [index, metadata] of unrelated.entries()) {
    await addClient(`unrelated-${String(index)}`, metadata);
  }
  await addClient("unrelated-managed", CLI_LOOPBACK_CLIENT_METADATA);
  await addClient("unrelated-discovery", CLI_LOOPBACK_CLIENT_METADATA);
  await database.exec(`UPDATE oauth_client SET registration_origin = 'managed' WHERE id = 'unrelated-managed';
    UPDATE oauth_client SET client_discovery_id = 'cimd' WHERE id = 'unrelated-discovery';`);
  await database.exec(`INSERT INTO oauth_consent VALUES ('consent', 'cli-0');
    INSERT INTO oauth_refresh_token VALUES ('refresh', 'cli-0');`);
  const connection = {
    release: () => undefined,
    execute: async (query, params = []) => {
      await database.query(query, [...params]);
    },
    query: async (query, params = []) =>
      (await database.query(query, [...params])).rows,
  } satisfies OnlineMigrationConnection;
  const unrelatedBefore = (
    await database.query(
      "SELECT * FROM oauth_client WHERE id LIKE 'unrelated-%' ORDER BY id",
    )
  ).rows;
  expect(
    (await CLI_OAUTH_CLIENT_NAME_REPAIR.readCompletion(connection)).type,
  ).toBe("incomplete");
  expect((await CLI_OAUTH_CLIENT_NAME_REPAIR.repair(connection)).type).toBe(
    "deferred",
  );
  expect(
    (await CLI_OAUTH_CLIENT_NAME_REPAIR.readCompletion(connection)).type,
  ).toBe("incomplete");
  expect((await CLI_OAUTH_CLIENT_NAME_REPAIR.repair(connection)).type).toBe(
    "deferred",
  );
  expect(
    (await CLI_OAUTH_CLIENT_NAME_REPAIR.readCompletion(connection)).type,
  ).toBe("complete");
  expect(
    (
      await database.query(
        "SELECT count(*)::integer AS count FROM oauth_client WHERE name = 'stella CLI'",
      )
    ).rows,
  ).toEqual([{ count: 201 }]);
  expect(
    (
      await database.query(
        "SELECT * FROM oauth_client WHERE id LIKE 'unrelated-%' ORDER BY id",
      )
    ).rows,
  ).toEqual(unrelatedBefore);
  expect((await database.query("SELECT * FROM oauth_consent")).rows).toEqual([
    { id: "consent", client_id: "cli-0" },
  ]);
  expect(
    (await database.query("SELECT * FROM oauth_refresh_token")).rows,
  ).toEqual([{ id: "refresh", client_id: "cli-0" }]);
  const repaired = (
    await database.query("SELECT * FROM oauth_client ORDER BY id")
  ).rows;
  await CLI_OAUTH_CLIENT_NAME_REPAIR.repair(connection);
  expect(
    (await database.query("SELECT * FROM oauth_client ORDER BY id")).rows,
  ).toEqual(repaired);
  await database.close();
});
