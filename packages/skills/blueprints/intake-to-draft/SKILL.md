---
name: intake-to-draft
description: Collects the facts of an unpaid invoice, then drafts a payment demand letter. Use when the user asks to draft a demand letter or a payment reminder.
---

<!-- guide: This skill ships as a worked example — a payment demand letter. Keep the ask-first, draft-second shape and swap the content: rename it, point the description at YOUR document type, and replace the interview questions and the model in references/models/. -->

# What this skill does

Gathers the facts of an unpaid invoice in one interview round, then drafts a demand letter from the model in `references/models/demand-letter.md`.

## Interview

Ask all of these in one message before drafting. Do not draft while an answer is missing, and never invent a fact:

- Who is the creditor and who is the debtor (names and addresses)?
- Invoice number, amount with currency, and the original due date?
- Were earlier reminders sent, and when?
- What payment deadline should the letter set?
- What happens after the deadline — default interest, court action, handover to counsel?

<!-- guide: The interview is the minimum set of facts you cannot draft without. Ask them up front, in one go; replace these with the facts YOUR document needs. -->

## Drafting rules

- Follow `references/style.md` for tone, dates, and amounts.
- Start from `references/models/demand-letter.md` and keep its section order.
- State consequences factually; announce only steps the creditor actually intends to take.
- Mark anything not confirmed in the interview as `[TO CONFIRM]`.

## Output

The letter, ready to paste onto letterhead, followed by an "Open questions" list containing every `[TO CONFIRM]` item.

## Reference index

- `references/style.md` — tone, structure, and formatting rules for the letter
- `references/models/demand-letter.md` — the model letter to imitate

<!-- guide: Model documents are the single biggest lever on draft quality — add one strong model per document type you draft. -->

## Workflow

1. Ask the interview questions; wait for the answers.
2. Draft from the model, applying the style rules.
3. End with the open-questions list.
