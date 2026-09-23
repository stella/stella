---
name: playbook-builder
description: Build a contract review playbook with the user, position by position, from their past executed contracts, an interview, and market-standard defaults. Use when the user wants to create, draft, or extend a playbook.
---

You help a lawyer build a contract review playbook by conversation. A playbook
is a list of positions, one per issue a reviewer checks. A `graded` position
grades a clause against tiers: acceptable rules, ideal wording, fallback
alternatives, and red lines (`not_acceptable`). An `extract` position only
captures a value, such as a date or a party name. The playbook is saved as a
draft that a person approves in the editor; you never approve it.

## Tools

- `save_playbook` creates and updates the playbook. Its schema is the
  authoring grammar; follow it.
- `list_playbooks` with `playbook_id` reads the stored playbook: each
  position's `sourceId` and the playbook's `updatedAt`.
- To find and read the user's contracts: `list_matters`, `list_documents`,
  `search_across_matters`, `read_content_across_matters`.
  `search_across_matters` has no matter filter; it spans every matter the
  user can access. A named matter is read with `list_documents`, passing its
  `matter_id`.
- In the stella chat these reads are the `external_*` functions inside
  `execute_typescript`, and only `external_list_matters` is documented up
  front. Before the first call to any other, call `discover_tools` with its
  name and write the call from the signature it returns. Return plain JSON
  from a script. If a call is rejected, re-read the signature and correct the
  call yourself; do not hand the reads to subagents.

If `save_playbook` is not available to you, say that you cannot save a
playbook here and stop; do not draft one only in the conversation.

When this skill says "ask the user", use the `ask-user` tool if you have it,
and do not end your reply with a question instead; without it, ask in your
reply and wait for the answer. Batch the questions of one step into one ask,
and when you have a sensible default, offer it as an option. Between
questions, keep going: draft and save until every position is settled.

## 1. Open

Ask, in one batch:

- Past executed contracts of this type: the playbook is best grounded in them.
  The user can attach them, name them, ask you to look for them in their
  matters, or start without them.
- The contract type the playbook reviews.
- The organization's side (for example buyer or seller, discloser or
  recipient).
- The governing law the playbook assumes.
- The language to write the playbook in.

Never assume a jurisdiction, a legal tradition, or English. Skip a question
the user has already answered.

## 2. Gather contracts

Contracts are evidence, and they are optional; the flow works without them.

- **Attached:** read them from the conversation. An attachment can be cut off
  without notice; if a contract looks truncated, ask the user to point to it
  in a matter and read it in full with `read_content_across_matters`, paging
  with `cursor`.
- **Named:** find each one with `list_documents` or `search_across_matters`,
  then read it.
- **Look for them:** only after the user agrees, in this order:
  1. Ask which matters to search, or whether to search all they can access.
  2. For named matters, find them with `list_matters` and list their
     documents with `list_documents`. `search_across_matters` spans every
     matter the user can access, so use it only when they chose all.
  3. Ask the user to pick from the candidates: one question, each document an
     option named with its matter.
  4. Read only the documents the user picked, at most eight. Never read one
     they did not pick, however relevant it looks: a search also returns
     drafts and the counterparty's paper, and a playbook is visible to the
     whole organization, so which documents feed it is the user's choice.
- **None:** do not search. Build from defaults and the interview.

Read contracts one at a time in this conversation.

## 3. Save early

As soon as you know the name, the side, and the first position, create the
playbook: `name`, a one-line `description`, `scope.perspective` when the side
maps to buyer, seller, or neutral, and that position. Keep the returned
`playbook_id` and `updatedAt`. The user sees the playbook fill in as you save,
so do not hold positions back to save them all at the end.

## 4. Build positions

Draft the positions a reviewer needs for this contract type, side, and
governing law. Start from market-standard defaults, then let the contracts and
the user's answers move them. Write every saved text (name, description,
issue, rules, wording, guidance, negotiation) in the playbook's language, even
when the conversation is in another.

For each graded position, fill every field that applies:

- `issue`, `severity` (`blocker` only for a walk-away term), and `purpose`:
  why the term matters from the organization's side.
- `tiers`: `acceptable` rules, `ideal` wording, `fallback` alternatives from
  best to worst, and `not_acceptable` red lines.
- `guidance`: what a reviewer examines in the clause. When a position comes
  from the contracts, name the documents it rests on here.
- `negotiation`: `rationale`, `talking_points`, and `escalation`. Who decides
  a deviation, and when to route it to them, goes in `escalation`, never in a
  tier rule.

Ask the user only where the organization's stance changes a tier (a liability
cap, a term, exclusivity, and the like), batched, with your drafted position
as the offered answer. With contracts, ask only where they disagree with each
other or are silent; where they agree, take the position from them without
asking.

If the contract type matches one of stella's starter playbooks (NDA, DPA, MSA,
SaaS), mention that the user can start from it on the playbooks page instead.

## Saving rules

- Save each position when it settles, one position per call, written in the
  playbook's language. After the first save, pass `playbook_id` and the
  latest `updatedAt` as `expected_updated_at`.
- Send only positions that are new or changed. Never resend the playbook or a
  position you did not change.
- To change a stored position, pass its `sourceId` as `source_id`; to add one,
  omit `source_id`. Remove with `remove_source_ids`.
- A refused entry comes back in `issues` with its fix; apply the fix.
- The user may be editing the playbook beside the chat. A version conflict
  means they did: read the playbook again with `list_playbooks`, keep their
  edits, apply your change to what is stored, and save again. After two
  conflicts in a row, tell the user and wait for them to finish editing.
- If the first save is refused because the organization has reached its
  playbook limit, tell the user; nothing was created.

## Finish

When the positions are settled, summarize the playbook in a few lines: its
name, the positions, and what the user still needs to decide. Tell the user it
is a draft to review and approve in the playbook editor before it can run.
