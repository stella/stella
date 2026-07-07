-- Playbooks positions JSONB v1 -> v2 (tiered authoring). Playbooks never
-- shipped publicly, so this lifts existing internal rows once; no runtime v1
-- read path survives. Per-item mapping:
--   extractOnly            -> { mode: "extract", ask: { question, content } }
--   graded (other kinds)   -> { mode: "graded", tiers, ask: { mode: "manual" } }
--     standard clause       -> tiers.acceptable.ideal (source clause)
--     standard inline pref   -> tiers.acceptable.ideal (source inline)
--     standard inline fbs    -> tiers.fallback.entries (fresh ids, rank order)
--     rule presence          -> check { kind: presence }
--     rule propertyConstraint -> check { kind: constraint }
--     rule positionMatch     -> no check (LLM tier-match, the default)
--   every position: enabled = true; container version = 2.
-- All existing rows are schema-valid v1, so the transform is total; there is no
-- shape it cannot express, so no row needs the {version:2, items:[]} fallback.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
UPDATE "playbook_definitions" AS pd
SET "positions" = jsonb_build_object(
  'version', 2,
  'items', COALESCE(
    (
      SELECT jsonb_agg(
        CASE
          WHEN elem.value -> 'rule' ->> 'kind' = 'extractOnly' THEN
            jsonb_build_object(
              'mode', 'extract',
              'sourceId', elem.value -> 'sourceId',
              'issue', elem.value -> 'issue',
              'ask', jsonb_build_object(
                'question', elem.value -> 'ask' -> 'question',
                'content', elem.value -> 'ask' -> 'content'
              ),
              'enabled', true
            )
            || CASE
                 WHEN elem.value ? 'guidance'
                   THEN jsonb_build_object('guidance', elem.value -> 'guidance')
                 ELSE '{}'::jsonb
               END
          ELSE
            jsonb_build_object(
              'mode', 'graded',
              'sourceId', elem.value -> 'sourceId',
              'issue', elem.value -> 'issue',
              'severity', elem.value -> 'severity',
              'ask', jsonb_build_object(
                'mode', 'manual',
                'question', elem.value -> 'ask' -> 'question',
                'content', elem.value -> 'ask' -> 'content'
              ),
              'enabled', true,
              'tiers', jsonb_build_object(
                'acceptable',
                  jsonb_build_object('rules', '[]'::jsonb)
                  || CASE
                       WHEN elem.value -> 'standard' ->> 'source' = 'clause' THEN
                         jsonb_build_object(
                           'ideal',
                           jsonb_build_object(
                             'source', 'clause',
                             'clauseId', elem.value -> 'standard' -> 'clauseId'
                           )
                           || CASE
                                WHEN elem.value -> 'standard' ? 'clauseVersion'
                                  THEN jsonb_build_object(
                                    'clauseVersion',
                                    elem.value -> 'standard' -> 'clauseVersion'
                                  )
                                ELSE '{}'::jsonb
                              END
                         )
                       WHEN elem.value -> 'standard' ->> 'source' = 'inline'
                            AND COALESCE(
                              elem.value -> 'standard' ->> 'preferred', ''
                            ) <> '' THEN
                         jsonb_build_object(
                           'ideal',
                           jsonb_build_object(
                             'source', 'inline',
                             'text', elem.value -> 'standard' -> 'preferred'
                           )
                         )
                       ELSE '{}'::jsonb
                     END,
                'fallback', jsonb_build_object(
                  'entries', COALESCE(
                    (
                      SELECT jsonb_agg(
                        jsonb_build_object(
                          'id', gen_random_uuid()::text,
                          'text', fb.value -> 'text'
                        )
                        || CASE
                             WHEN fb.value ? 'label'
                               THEN jsonb_build_object('label', fb.value -> 'label')
                             ELSE '{}'::jsonb
                           END
                        ORDER BY (fb.value ->> 'rank')::int
                      )
                      FROM jsonb_array_elements(
                        COALESCE(elem.value -> 'standard' -> 'fallbacks', '[]'::jsonb)
                      ) AS fb(value)
                    ),
                    '[]'::jsonb
                  )
                ),
                'notAcceptable', jsonb_build_object('rules', '[]'::jsonb)
              )
            )
            || CASE
                 WHEN elem.value ? 'guidance'
                   THEN jsonb_build_object('guidance', elem.value -> 'guidance')
                 ELSE '{}'::jsonb
               END
            || CASE
                 WHEN elem.value -> 'rule' ->> 'kind' = 'presence' THEN
                   jsonb_build_object('check', jsonb_build_object(
                     'kind', 'presence',
                     'expectation', elem.value -> 'rule' -> 'expectation'
                   ))
                 WHEN elem.value -> 'rule' ->> 'kind' = 'propertyConstraint' THEN
                   jsonb_build_object('check', jsonb_build_object(
                     'kind', 'constraint',
                     'condition', elem.value -> 'rule' -> 'condition'
                   ))
                 ELSE '{}'::jsonb
               END
        END
        ORDER BY elem.ord
      )
      FROM jsonb_array_elements(pd."positions" -> 'items')
        WITH ORDINALITY AS elem(value, ord)
    ),
    '[]'::jsonb
  )
)
WHERE pd."positions" ->> 'version' = '1';
