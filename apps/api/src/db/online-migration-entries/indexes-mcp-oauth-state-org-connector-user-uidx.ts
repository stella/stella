import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-mcp-oauth-state-org-connector-user-uidx",
  revision: 766,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.MCP_OAUTH_STATE_ORG_CONNECTOR_USER_UIDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
