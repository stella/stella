-- requires: 20261010005000_disable_legacy_desktop_credentials
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TEMP TABLE renamed_agent_skills (skill_id uuid PRIMARY KEY, old_content_hash text NOT NULL, old_body text NOT NULL) ON COMMIT DROP;--> statement-breakpoint
CREATE TEMP TABLE renamed_agent_skill_paths (skill_id uuid NOT NULL, old_path text NOT NULL, new_path text NOT NULL, PRIMARY KEY (skill_id, old_path)) ON COMMIT DROP;--> statement-breakpoint
CREATE FUNCTION pg_temp.fit_agent_skill_path(folder text, name text, suffix text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT
AS $$
DECLARE
  directory text := regexp_replace(name, '[^/]*$', '');
  basename text := regexp_replace(name, '^.*/', '');
  extension text;
  stem text;
  fitted_stem text;
  available integer;
BEGIN
  -- Legacy names may predate path validation; keep valid directory segments.
  IF directory !~ '^([a-z0-9][a-z0-9._-]*/)*$'
     OR directory ~ '\./' THEN
    directory := '';
  END IF;
  extension := COALESCE(substring(basename FROM '(\.[^./]+)$'), '');
  stem := left(basename, length(basename) - length(extension));
  stem := regexp_replace(stem, '[^a-z0-9._-]+', '-', 'g');
  stem := regexp_replace(stem, '^[^a-z0-9]+', '');
  stem := rtrim(stem, '.');
  IF stem = '' THEN
    stem := 'resource';
  END IF;
  extension := regexp_replace(extension, '[^a-z0-9._-]+', '-', 'g');
  extension := rtrim(extension, '.');
  available := 512 - length(folder) - length(directory) - length(suffix);
  -- If directories leave no room for a basename, keep only folder + basename.
  IF available < 1 THEN
    directory := '';
    available := 512 - length(folder) - length(suffix);
  END IF;
  -- Preserve an extension only when the destination still has room for a stem.
  IF length(extension) >= available THEN
    stem := stem || extension;
    extension := '';
  END IF;
  fitted_stem := rtrim(left(stem, available - length(extension)), '.');
  RETURN folder || directory || fitted_stem || suffix || extension;
END
$$;--> statement-breakpoint
DO $$
DECLARE
  resource record;
  target_path text;
  folder text;
  name text;
  suffix_text text;
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

    folder := substring(target_path FROM '^[^/]+/');
    name := substring(target_path FROM length(folder) + 1);
    suffix := 1;
    suffix_text := '';
    LOOP
      target_path := pg_temp.fit_agent_skill_path(folder, name, suffix_text);
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM agent_skill_resources
        WHERE skill_id = resource.skill_id
          AND path = target_path
          AND id <> resource.id
      );
      suffix := suffix + 1;
      suffix_text := '-' || suffix;
    END LOOP;

    -- stella-migration-safety: reviewed insert-select - capture one renamed skill hash in a transaction-local table; rollback discards the capture.
    INSERT INTO renamed_agent_skills (skill_id, old_content_hash, old_body)
    SELECT id, content_hash, body FROM agent_skills WHERE id = resource.skill_id
    ON CONFLICT DO NOTHING;
    INSERT INTO renamed_agent_skill_paths (skill_id, old_path, new_path)
    VALUES (resource.skill_id, resource.path, target_path);
    UPDATE agent_skill_resources SET path = target_path WHERE id = resource.id;
  END LOOP;
END
$$;--> statement-breakpoint
-- Literal matching avoids treating filename punctuation as regular expressions.
CREATE FUNCTION pg_temp.rewrite_agent_skill_paths(target_skill_id uuid, value text) RETURNS text
LANGUAGE plpgsql STABLE STRICT
AS $$
DECLARE
  mapping record;
  rewritten text := value;
  source_text text;
  result_text text;
  cursor_position integer;
  match_position integer;
BEGIN
  FOR mapping IN
    SELECT old_path, new_path FROM renamed_agent_skill_paths
    WHERE skill_id = target_skill_id
    ORDER BY length(old_path) DESC, old_path COLLATE "C"
  LOOP
    source_text := rewritten;
    result_text := '';
    cursor_position := 1;
    LOOP
      match_position := strpos(substring(source_text FROM cursor_position), mapping.old_path);
      EXIT WHEN match_position = 0;
      match_position := match_position + cursor_position - 1;
      result_text := result_text || substring(source_text FROM cursor_position FOR match_position - cursor_position);
      -- Allow a skill-root ./ prefix; parent-relative and nested paths differ.
      IF (substring(source_text FROM match_position - 1 FOR 1) !~ '[A-Za-z0-9_./-]'
          OR (match_position >= 3
              AND substring(source_text FROM match_position - 2 FOR 2) = './'
              AND substring(source_text FROM match_position - 3 FOR 1) !~ '[A-Za-z0-9_./-]'))
         AND substring(source_text FROM match_position + length(mapping.old_path) FOR 1) !~ '[A-Za-z0-9_./-]' THEN
        result_text := result_text || mapping.new_path;
      ELSE
        result_text := result_text || mapping.old_path;
      END IF;
      cursor_position := match_position + length(mapping.old_path);
    END LOOP;
    rewritten := result_text || substring(source_text FROM cursor_position);
  END LOOP;
  RETURN rewritten;
END
$$;--> statement-breakpoint
UPDATE agent_skill_resources resource
SET content = pg_temp.rewrite_agent_skill_paths(resource.skill_id, resource.content),
    size_bytes = octet_length(convert_to(pg_temp.rewrite_agent_skill_paths(resource.skill_id, resource.content), 'UTF8'))
FROM renamed_agent_skills renamed
WHERE resource.skill_id = renamed.skill_id
  AND resource.content IS DISTINCT FROM pg_temp.rewrite_agent_skill_paths(resource.skill_id, resource.content);--> statement-breakpoint
CREATE FUNCTION pg_temp.skill_hash_field(value text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT
RETURN convert_to(octet_length(convert_to(value, 'UTF8'))::text || ':', 'UTF8') || convert_to(value, 'UTF8');--> statement-breakpoint
CREATE FUNCTION pg_temp.recompute_agent_skill_hash(target_skill_id uuid, snapshot_body text) RETURNS text
LANGUAGE sql STABLE
RETURN (
  SELECT encode(sha256(
    pg_temp.skill_hash_field('stella-skill-content-v1') ||
    pg_temp.skill_hash_field(skill.name) ||
    pg_temp.skill_hash_field(skill.description) ||
    pg_temp.skill_hash_field(CASE WHEN skill.version IS NULL THEN 'absent' ELSE 'present' END) ||
    pg_temp.skill_hash_field(COALESCE(skill.version, '')) ||
    pg_temp.skill_hash_field(CASE WHEN skill.license IS NULL THEN 'absent' ELSE 'present' END) ||
    pg_temp.skill_hash_field(COALESCE(skill.license, '')) ||
    pg_temp.skill_hash_field(CASE WHEN skill.compatibility IS NULL THEN 'absent' ELSE 'present' END) ||
    pg_temp.skill_hash_field(COALESCE(skill.compatibility, '')) ||
    pg_temp.skill_hash_field((SELECT count(*)::text FROM jsonb_each_text(skill.metadata))) ||
    COALESCE((SELECT string_agg(pg_temp.skill_hash_field(entry.key) || pg_temp.skill_hash_field(entry.value), ''::bytea ORDER BY entry.key COLLATE "C") FROM jsonb_each_text(skill.metadata) AS entry), ''::bytea) ||
    pg_temp.skill_hash_field(snapshot_body) ||
    pg_temp.skill_hash_field((SELECT count(*)::text FROM agent_skill_resources resource WHERE resource.skill_id = skill.id)) ||
    COALESCE((SELECT string_agg(pg_temp.skill_hash_field(resource.path) || pg_temp.skill_hash_field(encode(sha256(convert_to(resource.content, 'UTF8')), 'hex')), ''::bytea ORDER BY resource.path COLLATE "C") FROM agent_skill_resources resource WHERE resource.skill_id = skill.id), ''::bytea)
  ), 'hex')
  FROM agent_skills skill
  WHERE skill.id = target_skill_id
);--> statement-breakpoint
DO $$
DECLARE
  previous_revision_mode text := current_setting('app.agent_skill_revision_mode', true);
BEGIN
  -- A cutover is a discrete revision even if a caller has an active autosave window.
  PERFORM set_config('app.agent_skill_revision_mode', 'isolated', true);
  UPDATE agent_skills skill
  SET body = rewritten.new_body,
      content_hash = pg_temp.recompute_agent_skill_hash(skill.id, rewritten.new_body)
  FROM (
    SELECT current_skill.id, pg_temp.rewrite_agent_skill_paths(current_skill.id, current_skill.body) AS new_body
    FROM agent_skills current_skill
    JOIN renamed_agent_skills renamed ON renamed.skill_id = current_skill.id
  ) rewritten
  WHERE skill.id = rewritten.id;
  PERFORM set_config('app.agent_skill_revision_mode', COALESCE(previous_revision_mode, ''), true);
END
$$;--> statement-breakpoint
UPDATE agent_skill_revisions revision
SET content_hash = skill.content_hash
FROM renamed_agent_skills renamed
JOIN agent_skills skill ON skill.id = renamed.skill_id
WHERE revision.skill_id = renamed.skill_id
  AND skill.body = renamed.old_body
  AND revision.content_hash = renamed.old_content_hash;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - resource kind is removed in the same clean cutover as its column.
ALTER TABLE agent_skill_resources DROP CONSTRAINT agent_skill_resources_kind_check;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-column - no clients retain the deleted resource kind contract.
ALTER TABLE agent_skill_resources DROP COLUMN kind;
