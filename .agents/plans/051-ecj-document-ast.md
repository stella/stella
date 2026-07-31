# 051 — ECJ document AST parsing

## Problem

Decisions ingested through the `eu-ecj` adapter carry `document_ast: {}` and no
sections: the reader renders them as an unstructured wall of text, the left
structure/AI margin stays empty, and long judgments are effectively unreadable.
Every national adapter (cz-us, sk-us, cz-ns, …) produces a structured
`DocumentAst`, so the reader experience for ECJ is far below the baseline.

## Test corpus already in the repo

`apps/api/scripts/__fixtures__/case-law/eu-ecj.json` contains the complete
English Schrems II judgment (C-311/18, ECLI:EU:C:2020:559, fetched from the
official Cellar manifestation) alongside three shorter recent ECJ decisions.
Schrems II is deliberately the acceptance corpus: it is long, has every
structural feature (headings, numbered paragraphs, rulings), and renders today
as the failure case this plan fixes. Seed with `bun run db:seed-case-law` and
open `/law/eu/cases/court-of-justice/c-311-18`.

## Where the work lives

- Adapter: `apps/api/src/handlers/case-law/ingestion/adapters/eu-ecj.ts`.
  It fetches the Cellar XHTML manifestation and currently falls back to
  `stripHtml` into `fulltext` only.
- AST types: `@stll/legal-ast` (`DocumentAst`, node kinds) and
  `apps/api/src/handlers/case-law/types.ts` (`DecisionSection`).
- Reference implementations: the cz-us / sk-us adapters build ASTs from
  national court HTML; mirror their section/AST construction approach, not
  their selectors.

## Shape of ECJ judgments (what the parser must recognise)

Curia/Cellar XHTML is stable and class-annotated. A judgment has:

- Header block: court/chamber line, date, the parenthesised keyword chain
  ("Reference for a preliminary ruling — …"), case number, parties, coram
  (judges, Advocate General, Registrar).
- Named headings in a fixed vocabulary: "Legal context" (with sub-headings
  "EU law" / "National law" / instrument names), "The dispute in the main
  proceedings and the questions referred", "Consideration of the questions
  referred" (with per-question sub-headings), "Costs", and the operative
  part introduced by "On those grounds, the Court (Grand Chamber) hereby
  rules:".
- Body paragraphs numbered `1`–`n`; quoted legislation as indented blocks;
  numbered rulings in the operative part.

## Acceptance

1. Ingesting (or reseeding) C-311/18 yields a non-empty `document_ast` and a
   section list; the reader shows the structure margin (headings navigable,
   AI margin populated) exactly like a national decision.
2. Paragraph numbering survives as structure, not text soup: a property-style
   test asserts the parsed paragraph numbers are strictly increasing and gap
   free for the fixture corpus.
3. Class guard so this cannot silently regress: a fixture test asserting every
   `eu-ecj` fixture decision parses to a non-empty AST (today's `{}` must
   become a failing state, not the accepted default).
4. Regenerate the eu-ecj fixture entries through the adapter (do not
   hand-patch the JSON) so fixture and adapter output cannot drift.
5. `bun run marketing:check` stays green; no landing changes are part of this
   plan (the homepage currently films national decisions on purpose).

## Non-goals

- No French/other-language manifestations; English only for now.
- No AG opinions; judgments only.
- No re-ingestion of the whole prod ECJ corpus in this plan; parser +
  fixtures + guards. A backfill runbook note at the end is enough.
