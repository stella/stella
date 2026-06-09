---
name: intake-to-draft
description: Interviews the user for the facts it needs, then drafts a document from them.
---

<!-- guide: Rewrite the name and description above. The description is the TRIGGER the assistant uses to decide when to run this skill, so name what it drafts and when. One sentence. e.g. "Collects the parties and key terms, then drafts a demand letter, when the user asks to draft one." -->

# What this skill does

> e.g. Gathers the facts needed for a [document type], then produces a first draft the user can edit.

<!-- guide: One sentence, one job. A draft skill works best when it asks first and writes second. -->

## Interview

<!-- guide: List the questions to ask BEFORE drafting — the minimum facts you cannot draft without. Ask them up front, in one go. Stop and ask if an answer is missing; do not invent facts. -->

> e.g.
>
> - Who are the parties?
> - What outcome does the user want?
> - Any deadline or key dates?

## Drafting rules

<!-- guide: How should the draft read? Tone, structure, length, what to leave as a fill-in. Keep style details in references/style.md and model documents in references/muster/. -->

> e.g. Professional and concise. Address each point. Mark anything uncertain as [TO CONFIRM] rather than guessing.

See `references/style.md` and `references/muster/`.

## Output

<!-- guide: Define the shape of the draft and anything that follows it (e.g. a short list of open questions for the user to confirm). -->

> e.g. The drafted document, followed by a short "Open questions" list.

## Reference index

- `references/style.md` — > e.g. tone and structure rules
- `references/muster/` — > e.g. model documents to imitate, one per type

## Workflow

1. Ask the interview questions; wait for answers.
2. > e.g. Pick the closest model from `references/muster/`.
3. Draft following `references/style.md`.
4. List any open questions for the user to confirm.

<!-- guide: Spell out the steps, including which model document to start from. -->
