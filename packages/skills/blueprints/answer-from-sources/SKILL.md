---
name: answer-from-sources
description: Answers data-protection (GDPR) questions grounded in the regulation and supervisory guidance, with a citation for every claim. Use for questions about personal data, consent, or data-subject rights.
---

<!-- guide: This skill ships as a worked example — GDPR Q&A. Keep the structure, swap the domain: rename it, point the description at the questions YOUR skill answers, and rebuild the source map in references/sources/. -->

# What this skill does

Answers a data-protection question by working through the sources in `references/sources/` in order of authority, citing the provision behind every claim.

## Input

A data-protection question. If two things are not obvious from it, ask for both at once before answering: the jurisdiction (EU-wide, or a member state whose national derogations matter) and the role of the party asking (controller or processor).

<!-- guide: State what comes in, and which missing context justifies a clarifying question. Ask once, not piecemeal. -->

## Sources

Authority order, highest first — on conflict, the higher source wins:

1. GDPR, the regulation text itself
2. CJEU case law interpreting it
3. EDPB guidelines and opinions
4. National supervisory-authority guidance
5. Commentary

National law may derogate where the GDPR leaves room (for example the age of consent or the employment context); flag it when the question touches such an area. The per-source notes live in `references/sources/`.

<!-- guide: The hierarchy is the heart of this pattern: write down what wins on conflict, and where national variation can change the general answer. -->

## Reasoning structure

Build every answer in four steps, in this order:

1. **Issue** — restate the question as the legal issue it raises.
2. **Source** — the governing provision(s), cited by article.
3. **Application** — how the provision applies to the facts asked.
4. **Answer** — the conclusion, and what remains open.

## Output rules

- Cite the article or guideline paragraph for every claim.
- Separate what the sources say from any practical suggestion.
- If the sources do not settle the question, say so explicitly; do not paper over the gap.
- Frame the answer as research support, not legal advice.

<!-- guide: Add your non-negotiables — answer language, how to handle conflicting sources, when to refuse. -->

## Reference index

- `references/sources/source-map.md` — the source list in authority order, with one row per source
- `references/sources/eu/gdpr.md` — orientation notes on the regulation itself

<!-- guide: Keep one line per file under references/ — this index is how the assistant decides which file to open. -->

## Workflow

1. Identify the issue; ask once for jurisdiction and role if missing.
2. Find the governing source via `references/sources/source-map.md`.
3. Apply the reasoning structure.
4. Answer with citations, flagging anything the sources leave open.
