import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-account-issuer-account-id-uidx",
  revision: 910,
  type: "replacements",
  // Better Auth 1.7.3 stopped writing `issuer`, so the account identity key is
  // (provider_id, account_id): the pair the library links accounts by. The
  // replacement is proven ready before this retires the legacy index, so no
  // window exists where neither enforces uniqueness.
  values: [
    {
      introducedBy: "20260916140000_account_issuer_nullable",
      legacyName: "account_issuer_account_id_uidx",
      replacementNames: ["account_provider_account_id_uidx"],
    },
  ],
} satisfies OnlineMigrationEntry;
