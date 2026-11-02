import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-apikey-personal-owner-keyset-idx",
  revision: 210,
  type: "indexes",
  values: [
    {
      createSql: `CREATE INDEX CONCURRENTLY "apikey_personal_owner_keyset_idx" ON public."apikey" (((metadata::jsonb ->> 'organizationId')), reference_id, created_at DESC, id DESC) WHERE metadata IS NOT NULL AND metadata::jsonb ->> 'kind' = 'personal'`,
      definitionBody:
        "ON public.apikey USING btree ((((metadata)::jsonb ->> 'organizationId'::text)), reference_id, created_at DESC, id DESC) WHERE ((metadata IS NOT NULL) AND (((metadata)::jsonb ->> 'kind'::text) = 'personal'::text))",
      introducedBy: "20261004120300_personal_api_keys",
      isUnique: false,
      name: "apikey_personal_owner_keyset_idx",
      tableName: "apikey",
    },
  ],
} satisfies OnlineMigrationEntry;
