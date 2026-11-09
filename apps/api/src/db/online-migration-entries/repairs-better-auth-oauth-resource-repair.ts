import { BETTER_AUTH_OAUTH_RESOURCE_REPAIR } from "../better-auth-oauth-resource-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-better-auth-oauth-resource-repair",
  revision: 1190,
  type: "repairs",
  values: [BETTER_AUTH_OAUTH_RESOURCE_REPAIR],
} satisfies OnlineMigrationEntry;
