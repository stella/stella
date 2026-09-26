SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Default skills are now installed when a membership is created. Members who
-- joined earlier got them lazily from the retired seed endpoint, gated on
-- owning no authored skill with a command in the organization; members who
-- never reached that path get them here, under the same gate, so defaults a
-- member deleted stay deleted. Rows and content hashes are those
-- seedDefaultSkills writes (apps/api/src/lib/agent-skills/default-skills.ts).
-- stella-migration-safety: reviewed insert-select - one-time seed of four private rows per unseeded membership; the membership table is small, the gate and ON CONFLICT DO NOTHING make a rerun write nothing, and rollback deletes the '*-default' private rows with no revisions beyond the first
INSERT INTO "agent_skills" (
  "id",
  "organization_id",
  "user_id",
  "scope",
  "origin",
  "slug",
  "name",
  "description",
  "metadata",
  "content_hash",
  "body",
  "enabled",
  "command"
)
SELECT
  gen_random_uuid(),
  m."organization_id",
  m."user_id",
  'private',
  'authored',
  d.command || '-default',
  d.name,
  d.description,
  '{}'::jsonb,
  d.content_hash,
  d.body,
  true,
  d.command
FROM "member" m
CROSS JOIN (
  VALUES
    ('summarize', 'Summarise a document', 'Get a structured summary of the key terms', 'Summarise this document. Cover parties, key obligations, dates, financial terms, and any termination or liability provisions.', '3747e20f3a37495f7a10bb5b19dc3ae1b95730349a0d8b697a3bc013036c735e'),
    ('risks', 'Find risks', 'Spot legal risks and ambiguous clauses', 'Review this document for legal risks, missing protections, and ambiguous clauses. Cite the specific clause for each finding.', '20a44eb95b2ab6323fda86fc8a5e65fe28c4ad3444f0c88f4731bd7360816b3d'),
    ('compare', 'Compare versions', 'List every material change between two versions', 'Compare two versions of this document and list every material change with its location.', '09289cd9551c311fad96a03ad818786567d6cace17fa74bd9d4e2ff6437a250f'),
    ('draft', 'Draft a response', 'Draft a professional reply to a letter', 'Draft a measured response to this letter. Keep the tone professional, address each point raised, and flag any open questions for me to confirm.', '5587e7c7992ad39e251b9ae605c10648969ab37770370cd4b18b2a46473cfd9e')
) AS d (command, name, description, body, content_hash)
WHERE NOT EXISTS (
  SELECT 1
    FROM "agent_skills" s
   WHERE s."organization_id" = m."organization_id"
     AND s."user_id" = m."user_id"
     AND s."origin" = 'authored'
     AND s."command" IS NOT NULL
)
ON CONFLICT DO NOTHING;
