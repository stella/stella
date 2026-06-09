---
name: check-against-rules
description: Reviews a non-disclosure agreement against the firm's NDA checklist and reports findings with citations. Use when the user attaches an NDA and asks to check or review it.
---

<!-- guide: This skill ships as a worked example — an NDA review. Keep the shape, swap the content: rename it, point the description at YOUR document type (the description is the TRIGGER the assistant uses to decide when to run the skill), and replace the checklist with your rules. -->

# What this skill does

Reviews a non-disclosure agreement clause by clause against `references/checklist.md` and reports every failed check, citing the rule and the clause that breaks it.

<!-- guide: One sentence, one job. If you need the word "and" to describe yours, consider splitting it into two skills. -->

## Input

An NDA attached by the user. If the document is not an NDA, say so and stop. If the governing law is not stated in the document, ask for it before judging the jurisdiction-dependent checks.

## Classification

| If the NDA is…                 | Then…                                            |
| ------------------------------ | ------------------------------------------------ |
| mutual (both parties disclose) | apply every check                                |
| one-way, client discloses      | skip C5 — one-way in the client's favour is fine |
| one-way, client receives       | C5 fails unless the imbalance is justified       |

<!-- guide: Many checks depend on WHAT KIND of input it is. Keep a small decision table that routes to the rules that apply; delete it if your check is uniform. -->

## What to flag

The rule set lives in `references/checklist.md` — one row per check, each with the concrete threshold that turns it into a finding. Only report what a checklist row supports; never flag from memory.

## Output

One table, one row per check:

| Code | Check | Status | Where | Note |
| ---- | ----- | ------ | ----- | ---- |

Status is `ok`, `fail`, or `n/a`. "Where" cites the clause or section of the reviewed document. After the table, summarise the failed checks in two or three sentences, worst first.

<!-- guide: Define the EXACT report shape so every run looks identical — name the columns. -->

## Output rules

- Cite the checklist code and the document clause for every finding.
- Report what the document says; whether to sign it is the lawyer's call, not the report's.
- If the document is incomplete or illegible, list what is missing instead of guessing.

<!-- guide: Add your non-negotiables: answer in one language, confidentiality notes, what to do with material from disclosure… -->

## Reference index

- `references/checklist.md` — the NDA checklist, one row per check (C1–C8)
- `references/jurisdiction/` — statute extracts the checks rely on, one file per act, split by jurisdiction
- `references/guidelines/` — regulator and bar-association guidance for borderline calls
- `references/case-law/` — decisions, one entry per case

<!-- guide: Keep one line per file under references/ — this index is how the assistant decides which file to open. -->

## Workflow

1. Confirm the document is an NDA and classify it (mutual or one-way).
2. Work through `references/checklist.md` top to bottom.
3. For borderline calls, consult `references/guidelines/` and `references/case-law/`.
4. Produce the report in the Output format, then the short summary.
