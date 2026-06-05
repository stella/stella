---
name: check-against-rules
description: Checks a document against a defined set of rules and returns findings with citations.
---

<!-- guide: Rewrite the name and description above. The description is the TRIGGER the assistant uses to decide when to run this skill, so name the document it reads and the ask that should load it. One sentence. e.g. "Reviews a non-disclosure agreement against a confidentiality checklist when a contract is attached and the user asks to check it." -->

# What this skill does

> e.g. Reviews a [document type] against [a body of rules] and reports what fails, with a citation for each finding.

<!-- guide: One sentence, one job. If you need the word "and" to describe it, consider splitting it into two skills. -->

## Input

> e.g. A [document] the user attaches, plus optionally [the rule set or jurisdiction].

<!-- guide: State what comes in. If a key fact is missing (document type, jurisdiction), tell the assistant to ASK before judging instead of guessing. -->

## Classification

<!-- guide: Many checks depend on WHAT KIND of input it is. Use a small decision table that routes to the rules that apply. Delete this section if your check is uniform. -->

| If the input is… | Apply… |
| --- | --- |
| > e.g. category A | > e.g. the rules in references/jurisdiction/... |
| > e.g. category B | > e.g. references/guidelines/... |

## What to flag

> e.g. - [item] — flag when [threshold]

<!-- guide: This is the heart of the skill. Keep the full list in references/checklist.md and point to it here so the body stays short. Every item must be concrete and testable. -->

See `references/checklist.md`.

## Output

<!-- guide: Define the EXACT report shape so every run looks identical. A table of findings? Bullets with a citation each? Name the columns. -->

> e.g. one row per check: FINDING | STATUS (ok / fail / n/a) | RULE | NOTE

## Output rules

- Always cite the specific rule (section, article, or case) for each finding.

<!-- guide: Add your non-negotiables. e.g. answer in one language; do not give legal advice; if the input is incomplete, ask. If the input may come from disclosure / a case file, note any use restriction before working with it. -->

## Reference index

<!-- guide: Keep one line per file under references/ describing what is inside it. This is how the assistant knows which file to open for a given question. -->

- `references/checklist.md` — > e.g. the quick checklist table
- `references/jurisdiction/` — > e.g. the rules, one file per act, split by jurisdiction
- `references/guidelines/` — > e.g. authority opinions, Q&A, soft law
- `references/case-law/` — > e.g. decisions, one entry per case

## Workflow

1. Classify the input.
2. > e.g. For borderline cases, consult `references/guidelines/`.
3. Check against `references/checklist.md`.
4. Produce the report in the Output format above.

<!-- guide: Spell out the steps the assistant follows, including WHICH reference file to consult for which situation. -->
