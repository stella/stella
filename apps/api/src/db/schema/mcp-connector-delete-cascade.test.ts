import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  chatToolGrants,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";

const connectorForeignKey = (table: PgTable) =>
  getTableConfig(table).foreignKeys.find(
    (foreignKey) => foreignKey.reference().foreignTable === mcpConnectors,
  );

// Deleting a connector (an administrator removing it) deletes every member's
// stored connection, and with it the encrypted tokens, in the same statement;
// grants for the connector go with it. Upstream revocation is separate.
test("deleting a connector deletes every member's stored tokens and grants for it", () => {
  expect(connectorForeignKey(mcpUserConnections)?.onDelete).toBe("cascade");
  expect(connectorForeignKey(chatToolGrants)?.onDelete).toBe("cascade");
});
