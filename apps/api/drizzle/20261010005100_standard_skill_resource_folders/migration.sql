-- requires: 20261010005000_disable_legacy_desktop_credentials
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TEMP TABLE renamed_agent_skills (skill_id uuid PRIMARY KEY) ON COMMIT DROP;--> statement-breakpoint
DO $$
DECLARE
  resource record;
  target_path text;
  stem text;
  extension text;
  suffix integer;
BEGIN
  FOR resource IN
    SELECT id, skill_id, path
    FROM agent_skill_resources
    WHERE path ~ '^(knowledge|prompts|reference|templates)/'
    ORDER BY skill_id, path, id
  LOOP
    target_path := regexp_replace(
      resource.path,
      '^(knowledge|prompts|reference)/',
      'references/'
    );
    target_path := regexp_replace(target_path, '^templates/', 'assets/');

    IF EXISTS (
      SELECT 1 FROM agent_skill_resources
      WHERE skill_id = resource.skill_id
        AND path = target_path
        AND id <> resource.id
    ) THEN
      extension := substring(target_path FROM '(\.[^./]+)$');
      IF extension IS NULL THEN
        stem := target_path;
        extension := '';
      ELSE
        stem := left(target_path, -length(extension));
      END IF;
      suffix := 2;
      WHILE EXISTS (
        SELECT 1 FROM agent_skill_resources
        WHERE skill_id = resource.skill_id
          AND path = stem || '-' || suffix || extension
          AND id <> resource.id
      ) LOOP
        suffix := suffix + 1;
      END LOOP;
      target_path := stem || '-' || suffix || extension;
    END IF;

    UPDATE agent_skill_resources SET path = target_path WHERE id = resource.id;
    INSERT INTO renamed_agent_skills (skill_id)
    VALUES (resource.skill_id)
    ON CONFLICT DO NOTHING;
  END LOOP;
END
$$;--> statement-breakpoint
CREATE FUNCTION pg_temp.skill_hash_field(value text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT
RETURN convert_to(octet_length(convert_to(value, 'UTF8'))::text || ':', 'UTF8') || convert_to(value, 'UTF8');--> statement-breakpoint
CREATE FUNCTION pg_temp.recompute_agent_skill_hash(target_skill_id uuid, snapshot_body text) RETURNS text
LANGUAGE sql STABLE
RETURN (
  SELECT encode(digest(
    skill_hash_field('stella-skill-content-v1') ||
    skill_hash_field(skill.name) ||
    skill_hash_field(skill.description) ||
    skill_hash_field(CASE WHEN skill.version IS NULL THEN 'absent' ELSE 'present' END) ||
    skill_hash_field(COALESCE(skill.version, '')) ||
    skill_hash_field(CASE WHEN skill.license IS NULL THEN 'absent' ELSE 'present' END) ||
    skill_hash_field(COALESCE(skill.license, '')) ||
    skill_hash_field(CASE WHEN skill.compatibility IS NULL THEN 'absent' ELSE 'present' END) ||
    skill_hash_field(COALESCE(skill.compatibility, '')) ||
    skill_hash_field((SELECT count(*)::text FROM jsonb_each_text(skill.metadata))) ||
    COALESCE((SELECT string_agg(skill_hash_field(entry.key) || skill_hash_field(entry.value), ''::bytea ORDER BY entry.key COLLATE "C") FROM jsonb_each_text(skill.metadata) AS entry), ''::bytea) ||
    skill_hash_field(snapshot_body) ||
    skill_hash_field((SELECT count(*)::text FROM agent_skill_resources resource WHERE resource.skill_id = skill.id)) ||
    COALESCE((SELECT string_agg(skill_hash_field(resource.path) || skill_hash_field(encode(digest(convert_to(resource.content, 'UTF8'), 'sha256'), 'hex')), ''::bytea ORDER BY resource.path COLLATE "C") FROM agent_skill_resources resource WHERE resource.skill_id = skill.id), ''::bytea),
    'sha256'
  ), 'hex')
  FROM agent_skills skill
  WHERE skill.id = target_skill_id
);--> statement-breakpoint
UPDATE agent_skills skill
SET content_hash = recompute_agent_skill_hash(skill.id, skill.body)
FROM renamed_agent_skills renamed
WHERE skill.id = renamed.skill_id;--> statement-breakpoint
UPDATE agent_skill_revisions revision
SET content_hash = recompute_agent_skill_hash(revision.skill_id, revision.body)
FROM renamed_agent_skills renamed
WHERE revision.skill_id = renamed.skill_id;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - resource kind is removed in the same clean cutover as its column.
ALTER TABLE agent_skill_resources DROP CONSTRAINT agent_skill_resources_kind_check;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-column - no clients retain the deleted resource kind contract.
ALTER TABLE agent_skill_resources DROP COLUMN kind;
