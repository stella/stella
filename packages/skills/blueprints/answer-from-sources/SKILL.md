---
name: answer-from-sources
description: Answers a question grounded in authoritative sources, with citations.
---

<!-- guide: Rewrite the name and description above. The description is the TRIGGER the assistant uses to decide when to run this skill, so name the kind of question it answers. One sentence. e.g. "Answers a data-protection question grounded in the regulation and guidance, with citations." -->

# What this skill does

> e.g. Answers a [domain] question by reasoning from [authoritative sources] and citing each step.

<!-- guide: One sentence, one job. This pattern is for questions, not document review. -->

## Input

> e.g. A question from the user about [domain].

<!-- guide: State what comes in. If the question is too broad or missing context (jurisdiction, dates), tell the assistant to ask a clarifying question first. -->

## Sources

<!-- guide: Define the hierarchy of authority — what to trust first, and which jurisdiction(s) apply. Keep the source map in references/sources/. -->

> e.g. Prefer [primary law] over [guidance] over [commentary]; for [jurisdiction] use ...

See `references/sources/`.

## Reasoning structure

<!-- guide: How should the answer be built? e.g. issue -> applicable source -> application -> conclusion. Keeping a fixed structure makes answers consistent and checkable. -->

> e.g. 1) the issue, 2) the governing source, 3) how it applies here, 4) the answer.

## Output rules

- Cite the source for every claim.
- Separate what the sources say from any practical suggestion.

<!-- guide: Add your non-negotiables. e.g. flag uncertainty; do not present an answer as legal advice; say when the sources do not settle the question. -->

## Reference index

- `references/sources/` — > e.g. the authority hierarchy and per-jurisdiction source list

## Workflow

1. Identify the issue; ask for missing context if needed.
2. Find the governing source via `references/sources/`.
3. Apply it using the reasoning structure above.
4. Answer with citations.

<!-- guide: Spell out the steps, including which source list to consult. -->
