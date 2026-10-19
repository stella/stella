import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";

import {
  buildContentSearchQueries,
  buildDocumentSearchQueries,
} from "./pg-fts-search-query";

const dialect = new PgDialect();

test("document search builders keep tenant, current-version and flow visibility predicates on every read", () => {
  const userId = toSafeId<"user">("01990000-0000-7000-8000-000000000003");
  const organizationId = toSafeId<"organization">(
    "searchfixtureorganization0000001",
  );
  const workspaceId = toSafeId<"workspace">(
    "01990000-0000-7000-8000-000000000001",
  );
  const queries = buildDocumentSearchQueries({
    userId,
    organizationId,
    workspaceIds: [workspaceId],
    kinds: ["document"],
    query: "needle",
    limit: 20,
  });
  const contentQueries = buildContentSearchQueries({
    userId,
    organizationId,
    workspaceId,
    query: "needle",
    limit: 20,
  });
  for (const query of [
    ...Object.values(queries),
    ...Object.values(contentQueries),
  ]) {
    const rendered = dialect.sqlToQuery(query);
    expect(rendered.sql).toContain("sd.organization_id =");
    expect(rendered.sql).toContain("sd.updated_at >= ev.created_at");
    expect(rendered.sql).toContain("sd.tsv @@");
    expect(rendered.sql).toContain("e.feature_owner");
    expect(rendered.sql).toContain("e.workspace_id = sd.workspace_id");
    expect(rendered.sql.match(/JOIN entities e /gu)).toHaveLength(1);
    expect(rendered.sql).not.toContain("flow_visibility_entity");
    expect(rendered.params).toContain(organizationId);
  }
  expect(dialect.sqlToQuery(queries.hitsQuery).params).toContain(21);
});
