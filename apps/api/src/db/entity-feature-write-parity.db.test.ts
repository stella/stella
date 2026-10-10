import { expect, test } from "bun:test";

import { createTestPglite } from "@/api/tests/pglite-test-db";

test("scalar gate writes and propagation match graph-derived visibility across scopes", async () => {
  const client = await createTestPglite();
  const organizationId = `org_${Bun.randomUUIDv7()}`;
  const workspaceId = Bun.randomUUIDv7();
  const otherWorkspaceId = Bun.randomUUIDv7();
  const entityId = Bun.randomUUIDv7();
  const versionId = Bun.randomUUIDv7();
  const propertyId = Bun.randomUUIDv7();
  const otherPropertyId = Bun.randomUUIDv7();
  const fieldId = Bun.randomUUIDv7();
  const assertParity = async () => {
    const result = await client.query(`
      SELECT bool_and(actual_gate = expected->>'state'
        AND workspace_ids = coalesce(expected->'workspaceIds', '[]'::jsonb)) AS matches
      FROM (
        SELECT entity_feature_gate AS actual_gate, '[]'::jsonb AS workspace_ids,
          public.entity_feature_gate_value('entity_versions', to_jsonb(v)) AS expected
        FROM entity_versions v
        UNION ALL
        SELECT entity_feature_gate, to_jsonb(entity_feature_workspace_ids),
          public.entity_feature_gate_value('fields', to_jsonb(f)) FROM fields f
        UNION ALL
        SELECT entity_feature_gate, to_jsonb(entity_feature_workspace_ids),
          public.entity_feature_gate_value('search_documents', to_jsonb(d)) FROM search_documents d
      ) gates`);
    expect(result.rows).toEqual([{ matches: true }]);
  };
  try {
    await client.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Gate parity', $1, now())",
      [organizationId],
    );
    await client.query(
      "INSERT INTO workspaces (id, organization_id, name, reference) VALUES ($1, $3, 'Gate A', 'gate-a'), ($2, $3, 'Gate B', 'gate-b')",
      [workspaceId, otherWorkspaceId, organizationId],
    );
    await client.query(
      "INSERT INTO entities (id, workspace_id, kind, name) VALUES ($1, $2, 'task', 'Gate parity')",
      [entityId, workspaceId],
    );
    await client.query(
      "INSERT INTO entity_versions (id, workspace_id, entity_id) VALUES ($1, $2, $3)",
      [versionId, workspaceId, entityId],
    );
    await client.query(
      `INSERT INTO properties (id, workspace_id, name, status, content, tool)
       VALUES ($1, $2, 'Gate parity', 'fresh', '{"type":"text","version":1}', '{"type":"manual-input","version":1}')`,
      [propertyId, workspaceId],
    );
    await client.query(
      `INSERT INTO properties (id, workspace_id, name, status, content, tool)
       VALUES ($1, $2, 'Other gate property', 'fresh', '{"type":"text","version":1}', '{"type":"manual-input","version":1}')`,
      [otherPropertyId, otherWorkspaceId],
    );
    await client.query(
      `INSERT INTO fields (id, workspace_id, entity_version_id, property_id, content)
       VALUES ($1, $2, $3, $4, '{"type":"text","version":1,"value":"Gate parity"}')`,
      [fieldId, workspaceId, versionId, propertyId],
    );
    await client.query(
      "INSERT INTO search_documents (entity_id, workspace_id, organization_id, kind) VALUES ($1, $2, $3, 'document')",
      [entityId, workspaceId, organizationId],
    );
    for (const childWorkspaceId of [workspaceId, otherWorkspaceId]) {
      await client.query(
        "UPDATE fields SET workspace_id = $1, property_id = $2",
        [
          childWorkspaceId,
          childWorkspaceId === workspaceId ? propertyId : otherPropertyId,
        ],
      );
      await client.query("UPDATE search_documents SET workspace_id = $1", [
        childWorkspaceId,
      ]);
      for (const listItemType of [null, "task", "fact"]) {
        await client.query("UPDATE entities SET list_item_type = $1", [
          listItemType,
        ]);
        await assertParity();
        await client.exec(`UPDATE fields SET entity_feature_gate = 'open', entity_feature_workspace_ids = '{}';
          UPDATE search_documents SET entity_feature_gate = 'open', entity_feature_workspace_ids = '{}';`);
        await assertParity();
      }
    }
    // Exercise the rollout state without relaxing the shipped ready constraint.
    // This isolated database models a version awaiting the bounded backfill.
    await client.exec(`ALTER TABLE entity_versions DROP CONSTRAINT entity_feature_gate_ready_check;
      ALTER TABLE entity_versions DISABLE TRIGGER entity_feature_gate_write;
      UPDATE entity_versions SET entity_feature_gate = 'pending';
      ALTER TABLE entity_versions ENABLE TRIGGER entity_feature_gate_write;
      UPDATE fields SET content = content;`);
    const pending = await client.query(
      `SELECT entity_feature_gate FROM fields`,
    );
    expect(pending.rows).toEqual([{ entity_feature_gate: "legal-lists" }]);
    await client.exec(
      "UPDATE entity_versions SET entity_feature_gate = entity_feature_gate",
    );
    await assertParity();
  } finally {
    await client.close();
  }
});
