SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A research answer's cited decision passage now names the court's own
-- paragraph number for its block (`courtParagraphNumber`, null when the court
-- printed none). Passages stored before the field existed did not record one,
-- and their decision's AST is not read here, so they state null: "no number",
-- the same value a passage of an unnumbered decision stores. Every reader of
-- the block can then rely on the field being present.
--
-- Bounded by its WHERE clause to runs holding a passage without the field;
-- research answers are feature-gated and hold few rows.
UPDATE "case_law_research_answers"
SET "run" = jsonb_set(
  "run",
  '{justification,blocks}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN item.block ->> 'kind' = 'decision-passage'
          AND NOT item.block ? 'courtParagraphNumber'
        THEN item.block || '{"courtParagraphNumber": null}'::jsonb
        ELSE item.block
      END
      ORDER BY item.position
    )
    FROM jsonb_array_elements("run" -> 'justification' -> 'blocks')
      WITH ORDINALITY AS item(block, position)
  )
)
WHERE jsonb_path_exists(
  "run",
  '$.justification.blocks[*] ? (@.kind == "decision-passage" && !exists(@.courtParagraphNumber))'
);
