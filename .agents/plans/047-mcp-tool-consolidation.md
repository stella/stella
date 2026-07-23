# Plan: MCP Tool Surface Consolidation

Date: 2026-07-05

Analysis of the complete 45-tool static MCP registry and the consolidation it
warrants. Approved scope: M1-M5 plus both `read_*` -> `list_*` renames; the
rejected merges (see the "Rejected merges" section) stay rejected. Implemented
on `feat/mcp-tool-consolidation`: the surface drops from 45 tools to 40 (with
`template_marker_reference` re-homed as an MCP resource), the `TOOL_COUNT_CEILING`
ratchets to 40 (default) / 21 (anonymized) with 45 kept as the hard product cap.

## TL;DR

- The binding constraint is the **tool-count ceiling (45, and we are AT it)**, not
  the char budget (default surface measures 50,099 chars against a 56,000 ceiling).
  Consolidation buys **count headroom**, which is the scarce resource.
- **4 clean, idiom-aligned merges** recover **4 slots** (45 → 41) with zero policy
  weakening. A 5th move (`template_marker_reference` → MCP resource) recovers one
  additional slot (→ 40). All five, plus the two renames, are IMPLEMENTED on this
  branch; later sections keep the original proposal framing for the rationale.
- The **4 "search" tools do NOT merge** — not because it's hard, but because their
  anonymized egress policies diverge (tenant-private `anonymize` vs public
  `passthrough`). A merged tool's policy must cover the union; here the union forces
  either over-redaction of public data or, worse, a fail-open leak of tenant text.
  **Reject on policy grounds.** This is the decisive, structural answer.
- The **compat `search`/`fetch` pair stays untouched**: those exact names + I/O shape
  are an external contract for OpenAI ChatGPT connectors / deep-research clients. They
  are the one accepted duplication.
- Everything merged stays **within a single write scope** and **within a single
  anonymized policy class**, so per-domain least privilege and fail-closed redaction
  are preserved.

---

## 1. Complete 45-tool inventory

Scope / feature / anonymized policy / one-line purpose. `anon` column: `A`=anonymize
(enumerable textFields), `P`=passthrough (public data), `X:w`=excluded (write),
`X:dyn`=excluded (dynamic tenant payload, fail-closed).

| #   | Tool                          | Scope           | Feature      | anon  | Purpose                                                              |
| --- | ----------------------------- | --------------- | ------------ | ----- | -------------------------------------------------------------------- |
| 1   | `search`                      | search          | —            | A     | Compat (OpenAI-shape) search over tenant knowledge → id/title/url    |
| 2   | `fetch`                       | read            | —            | A     | Compat (OpenAI-shape) fetch doc text by id, windowed                 |
| 3   | `list_matters`                | read            | —            | A     | List accessible matters                                              |
| 4   | `get_matter_overview`         | read            | —            | A     | One matter's dashboard (counts, recent entities, contacts, members)  |
| 5   | `search_across_matters`       | search          | —            | A     | Native cross-matter search → hits                                    |
| 6   | `search_case_law`             | search          | PUBLIC_LAW   | P     | Search public case-law corpus                                        |
| 7   | `read_content_across_matters` | read            | —            | A     | Read a doc's extracted text by id, windowed                          |
| 8   | `read_case_law_decision`      | read            | PUBLIC_LAW   | P     | Read one case-law decision, windowed                                 |
| 9   | `read_contact`                | read            | —            | A     | Read one contact (no list sibling)                                   |
| 10  | `set_practice_jurisdictions`  | onboarding      | —            | X:w   | Set org practice jurisdictions (onboarding recovery)                 |
| 11  | `list_templates`              | templates       | —            | A     | List document templates                                              |
| 12  | `describe_template`           | templates       | —            | A     | Read one template's fillable-field config (round-trips to configure) |
| 13  | `fill_template`               | templates       | —            | X:w   | Fill a template, return text + DOCX                                  |
| 14  | `template_marker_reference`   | templates       | —            | P     | Static `{{...}}` grammar doc; no args                                |
| 15  | `create_template`             | templates       | —            | X:w   | Create template from DOCX + optional fields overlay                  |
| 16  | `configure_template_fields`   | templates       | —            | X:w   | Configure an existing template's fields                              |
| 17  | `list_documents`              | read            | —            | A     | List docs/folders in a matter (flat/children)                        |
| 18  | `read_document`               | read            | —            | A     | Read one doc's metadata/fields/versions/**diff**                     |
| 19  | `create_document`             | documents_write | —            | X:w   | Create doc/folder                                                    |
| 20  | `update_document`             | documents_write | —            | X:w   | Rename/move/annotate a doc                                           |
| 21  | `delete_document`             | documents_write | —            | X:w   | Delete doc or one version                                            |
| 22  | `list_properties`             | read            | —            | A     | List a matter's column (property) definitions                        |
| 23  | `set_field_value`             | documents_write | —            | X:w   | Set a doc's cell for a property                                      |
| 24  | `save_matter`                 | matters_write   | —            | X:w   | Create/update/archive a matter                                       |
| 25  | `delete_matter`               | matters_write   | —            | X:w   | Delete a matter                                                      |
| 26  | `save_contact`                | matters_write   | —            | X:w   | Create/update a contact                                              |
| 27  | `delete_contact`              | matters_write   | —            | X:w   | Delete a contact                                                     |
| 28  | `lookup_business_registry`    | read            | —            | P     | Query a public business register                                     |
| 29  | `list_tasks`                  | read            | —            | A     | List tasks / read one task                                           |
| 30  | `save_task`                   | matters_write   | —            | X:w   | Create/update task + assignees + links                               |
| 31  | `link_matter_contact`         | matters_write   | —            | X:w   | Link/unlink contact↔matter party role                                |
| 32  | `list_clauses`                | read            | —            | A     | List clauses / read one clause + versions                            |
| 33  | `save_clause`                 | knowledge_write | —            | X:w   | Create/update a clause                                               |
| 34  | `delete_clause`               | knowledge_write | —            | X:w   | Delete a clause                                                      |
| 35  | `list_playbooks`              | read            | —            | A     | List playbooks / read one                                            |
| 36  | `run_playbook`                | knowledge_write | —            | X:w   | Run a review playbook over a matter                                  |
| 37  | `list_time_entries`           | read            | TIME_BILLING | A     | List time entries / read one                                         |
| 38  | `save_time_entry`             | billing_write   | TIME_BILLING | X:w   | Create/update a time entry                                           |
| 39  | `delete_time_entry`           | billing_write   | TIME_BILLING | X:w   | Delete/write-off a time entry                                        |
| 40  | `resolve_rate`                | read            | TIME_BILLING | P     | Compute effective hourly rate                                        |
| 41  | `read_invoices`               | read            | TIME_BILLING | A     | List invoices / read one                                             |
| 42  | `get_usage`                   | read            | USAGE        | P     | Read org usage entitlement; no args                                  |
| 43  | `search_legislation`          | read            | PUBLIC_LAW   | P     | Search **and** read Spanish BOE legislation                          |
| 44  | `read_audit_log`              | admin_read      | —            | X:dyn | Read org audit trail (fails closed on free-form diffs)               |
| 45  | `manage_organization`         | admin_write     | —            | X:w   | Admin action dispatcher (members, org settings)                      |

**Established idioms already in place** (the consolidation target, not new): `save_*`
merges create+update (matter, contact, task, clause, time_entry); `list_*` absorbs
read-one via an id param (tasks, clauses, playbooks, time_entries; `read_invoices`
does this too but is misnamed); `search_legislation` already folds search+read into one
tool; `manage_organization` is a single multi-action write.

---

## 2. Grouping by consumer intent

| Group                             | Tools                                                                                                                                                                           | Consolidation state                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **A. Find & read text**           | search, fetch, search_across_matters, read_content_across_matters, search_case_law, read_case_law_decision, search_legislation                                                  | Fragmented by design (different corpora + policies). See §4 rejects. |
| **B. Templates**                  | list_templates, describe_template, fill_template, template_marker_reference, create_template, configure_template_fields                                                         | **Pre-idiom. 6 → 4 (or 3).** Biggest win.                            |
| **C. Documents**                  | list_documents, read_document, create_document, update_document, delete_document, list_properties, set_field_value                                                              | **7 → 6** (save_document).                                           |
| **D. Matters / contacts / tasks** | list_matters, get_matter_overview, save_matter, delete_matter, read_contact, save_contact, delete_contact, lookup_business_registry, list_tasks, save_task, link_matter_contact | **list_matters ← overview.** Contact read/list gap noted.            |
| **E. Knowledge**                  | list_clauses, save_clause, delete_clause, list_playbooks, run_playbook                                                                                                          | Already idiom-clean. No change.                                      |
| **F. Billing**                    | list_time_entries, save_time_entry, delete_time_entry, resolve_rate, read_invoices, get_usage                                                                                   | Idiom-clean. Optional rename only.                                   |
| **G. Research / admin**           | search_legislation, read_audit_log, manage_organization                                                                                                                         | Already consolidated. No change.                                     |
| **H. Onboarding**                 | set_practice_jurisdictions                                                                                                                                                      | Standalone by design (least-privilege scope). No change.             |

---

## 3. Old → new mapping (all 45)

Action key: **KEEP** · **RENAME** · **MERGE→x** (this tool disappears into x) ·
**ABSORB(y)** (this tool stays and swallows y) · **RESOURCE** (leave the tool set).

| #   | Tool                        | Action          | New name                    | One-line justification                                                          |
| --- | --------------------------- | --------------- | --------------------------- | ------------------------------------------------------------------------------- |
| 1   | search                      | KEEP            | search                      | OpenAI connector contract; exact name/shape mandated.                           |
| 2   | fetch                       | KEEP            | fetch                       | OpenAI connector contract.                                                      |
| 3   | list_matters                | ABSORB(4)       | list_matters                | list-or-read-one idiom (as list_tasks); `matter_id` → overview.                 |
| 4   | get_matter_overview         | MERGE→3         | —                           | Read-one folds into the list tool; drops a non-idiomatic `get_` verb.           |
| 5   | search_across_matters       | KEEP            | search_across_matters       | Tenant `anonymize`; can't share a tool with public `passthrough` corpora.       |
| 6   | search_case_law             | KEEP            | search_case_law             | Public `passthrough`; policy differs from tenant search.                        |
| 7   | read_content_across_matters | KEEP            | read_content_across_matters | Windowed single-doc read; deliberate search→read split.                         |
| 8   | read_case_law_decision      | KEEP            | read_case_law_decision      | Windowed read; merge into search_case_law creates cursor double-duty (§4).      |
| 9   | read_contact                | KEEP            | read_contact                | Single-item read; no list sibling to fold into (gap noted §6).                  |
| 10  | set_practice_jurisdictions  | KEEP            | set_practice_jurisdictions  | `onboarding` scope = lower privilege than admin_write; must stay separate.      |
| 11  | list_templates              | ABSORB(12)      | list_templates              | list-or-read-one; `template_id` → field detail.                                 |
| 12  | describe_template           | MERGE→11        | —                           | Read-one of a template folds into its list, per the dominant idiom.             |
| 13  | fill_template               | KEEP            | fill_template               | Distinct write action (assemble + render); not a create/update of the resource. |
| 14  | template_marker_reference   | RESOURCE (opt.) | —                           | Static grammar doc → MCP resource; frees a slot, off the tool ceiling.          |
| 15  | create_template             | ABSORB(16)      | **save_template**           | save_* create+update idiom; omit id+docx → configure existing.                  |
| 16  | configure_template_fields   | MERGE→15        | —                           | Update path of the template resource; de-dupes the huge fields overlay schema.  |
| 17  | list_documents              | KEEP            | list_documents              | Keep separate from read_document (diff-mode density, §4).                       |
| 18  | read_document               | KEEP            | read_document               | Diff/version/compare modes too dense to fold into the list.                     |
| 19  | create_document             | ABSORB(20)      | **save_document**           | save_* create+update idiom.                                                     |
| 20  | update_document             | MERGE→19        | —                           | Update path folds into save_document; reconcile `title`→`name`.                 |
| 21  | delete_document             | KEEP            | delete_document             | Only delete_* stays standalone.                                                 |
| 22  | list_properties             | KEEP            | list_properties             | Distinct resource (schema columns), not documents.                              |
| 23  | set_field_value             | KEEP            | set_field_value             | Distinct cell write; different granularity from save_document.                  |
| 24  | save_matter                 | KEEP            | save_matter                 | Already the target idiom.                                                       |
| 25  | delete_matter               | KEEP            | delete_matter               | Standalone delete.                                                              |
| 26  | save_contact                | KEEP            | save_contact                | Already idiom.                                                                  |
| 27  | delete_contact              | KEEP            | delete_contact              | Standalone delete.                                                              |
| 28  | lookup_business_registry    | KEEP            | lookup_business_registry    | Public `passthrough`; won't share a policy with tenant reads.                   |
| 29  | list_tasks                  | KEEP            | list_tasks                  | Already list-or-read-one.                                                       |
| 30  | save_task                   | KEEP            | save_task                   | Already idiom.                                                                  |
| 31  | link_matter_contact         | KEEP            | link_matter_contact         | Distinct relation write; not a create/update of matter or contact.              |
| 32  | list_clauses                | KEEP            | list_clauses                | Already idiom.                                                                  |
| 33  | save_clause                 | KEEP            | save_clause                 | Already idiom.                                                                  |
| 34  | delete_clause               | KEEP            | delete_clause               | Standalone delete.                                                              |
| 35  | list_playbooks              | KEEP            | list_playbooks              | Already idiom.                                                                  |
| 36  | run_playbook                | KEEP            | run_playbook                | Distinct action verb.                                                           |
| 37  | list_time_entries           | KEEP            | list_time_entries           | Already idiom.                                                                  |
| 38  | save_time_entry             | KEEP            | save_time_entry             | Already idiom.                                                                  |
| 39  | delete_time_entry           | KEEP            | delete_time_entry           | Standalone delete.                                                              |
| 40  | resolve_rate                | KEEP            | resolve_rate                | Distinct compute action.                                                        |
| 41  | read_invoices               | RENAME (opt.)   | **list_invoices**           | It's list-or-read-one; `read_` misnames it vs list_time_entries.                |
| 42  | get_usage                   | KEEP            | get_usage                   | Distinct no-arg read.                                                           |
| 43  | search_legislation          | KEEP            | search_legislation          | Public `passthrough`; already search+read combined.                             |
| 44  | read_audit_log              | RENAME (opt.)   | **list_audit_log**          | List-only; `read_` misnames it. Fail-closed exclusion unchanged.                |
| 45  | manage_organization         | KEEP            | manage_organization         | Already a consolidated multi-action write.                                      |

**Net: 45 → 41** (four MERGE rows: #4, #12, #16, #20). **→ 40** if #14 becomes a
resource. Renames (#41, #44) are slot-neutral.

---

## 4. Recommended merges — detail, policy check, deltas

For every merge the rule is: **the merged tool's anonymized policy must cover the
union of its parts' text fields, and must not mix policy classes.** All four pass.

### M1 — `list_matters` ABSORB `get_matter_overview`

- **Why:** list-or-read-one is the dominant idiom (list_tasks/list_clauses/…). `get_*`
  is a naming outlier. `matter_id` param selects overview.
- **Policy:** both `anonymize`. Merged textFields = union
  (`matters[].name` ∪ `matter.name`, `matter.clientName`,
  `overview.recentEntities[].{name,createdBy,assignedTo}`, `contacts[].displayName`,
  `members[].name`). Egress skips absent fields, so list-mode payloads simply don't hit
  the overview-only fields. **No fail-closed weakening.** ✓
- **Schema cost:** +1 optional `matter_id`. Trivial. Output shape is dual (list vs
  overview) exactly as list_tasks already is.
- **Deltas:** default −1 slot, ~−350 chars. Anonymized surface 24 → 23.

### M2 — `list_templates` ABSORB `describe_template`

- **Why:** same idiom; `describe_*` is a pre-idiom outlier. `template_id` → field
  detail. Round-trip (detail output feeds `save_template`) preserved.
- **Policy:** both `anonymize`. Union = `templates[].{name,whenToUse,whenNotToUse}` ∪
  `name`, `fields[].{label,hint,aiPrompt}`. Enumerable, no weakening. ✓
- **Schema cost:** +1 optional `template_id`. Trivial.
- **Deltas:** default −1 slot, ~−620 chars. Anonymized 23 → 22.

### M3 — `save_template` = `create_template` + `configure_template_fields`

- **Why:** `save_*` create+update idiom. Omit `template_id`+`docx_base64` → create;
  pass `template_id`+`fields` → configure existing. Mirrors save_matter/save_task.
- **Policy:** both `X:w` (excluded/write). Merged = write → never on anonymized
  surface. **No policy surface at all.** ✓
- **Schema cost:** _net simpler on the wire._ Both tools currently serialize the full
  ~1.5k-char `fieldsOverlayProp`; merged it appears **once**. Create-only
  (`docx_base64`) vs update-only fields are distinguished by presence, as elsewhere.
- **Deltas:** default −1 slot, **~−1,800 chars** (the de-duplicated overlay).

### M4 — `save_document` = `create_document` + `update_document`

- **Why:** `save_*` idiom. Omit `entity_id` → create; pass it → update. Reconcile the
  `title` (create) / `name` (update) naming to a single `name`.
- **Policy:** both `X:w`. Merged is write. No anonymized surface. ✓
- **Schema cost:** create-only (`matter_id`, `kind`) vs update-only (`move_to_root`,
  `version_id`, `label`, `description`) fields; matches save_matter density.
- **Deltas:** default −1 slot, ~−800 chars.

### M5 (optional) — `template_marker_reference` → MCP **resource**

- Static, no-arg grammar documentation is the textbook MCP _resource_, not a _tool_.
  Moving it frees a slot and takes it off both the 45-count and the char ceilings, with
  zero ergonomic loss for resource-aware clients.
- **Caveat:** some MCP clients read tools but not resources. If that matters, keep it as
  a tool — it is the cheapest one (empty schema). **Lower priority than M1–M4.**

**Combined:** −4 slots (45 → 41), or −5 with M5 (→ 40). Default payload ~50,099 →
~46,500 chars; anonymized surface 24 → 22. **The char budgets were never the binding
constraint — the count ceiling is — so the real prize is 4–5 recovered slots below the
hard 45 cap.**

---

## 5. Rejected merges (keep-simple / fail-closed calls)

Honest "do NOT merge" list. Each would either weaken a fail-closed policy or make a
schema meaningfully harder for an LLM.

- **The 4 search tools (search_across_matters / search_case_law / search_legislation /
  compat search).** **Reject on policy grounds.** Tenant search is `anonymize`;
  case-law and legislation are public `passthrough`. A merged `search(corpus=…)` would
  need one policy covering the union — either over-redacting public data or, if it
  defaulted to passthrough, **leaking un-redacted tenant text**. The divergent egress
  policy is a structural reason they must stay separate, independent of schema size
  (which would also balloon: the union of case-law + legislation + tenant filter sets).
- **`read_case_law_decision` into `search_case_law`.** Tempting (mirror
  search_legislation), but case-law read is **cursor-windowed**, so the merged tool's
  `cursor` would mean "next search page" _or_ "next text window" depending on mode —
  the exact ambiguity that hurts LLMs. legislation avoids this (read mode uses
  `block_id`/`full_text`, not the search cursor). **Keep split.**
- **`read_document` into `list_documents`.** read_document carries three modes
  (metadata, version history, **two-version diff**). Folding them onto the list tool
  yields a schema whose params (`mode`/`parent_id` vs
  `version_id`/`compare_with_version_id`/`include_versions`/`versions_cursor`) are
  mutually exclusive by mode — high model-confusion cost. The idiom fits light read-ones
  (list_tasks); this read-one is heavy. **Keep separate.**
- **Native search→read (search_across_matters + read_content_across_matters) into one.**
  Combining a paginated multi-hit search with a windowed single-doc read reintroduces
  the two-cursor ambiguity and breaks parity with the compat search/fetch mental model.
  **Keep the pair.**
- **`set_practice_jurisdictions` into `manage_organization`.** Would escalate the
  required scope from `stella:onboarding` (grantable to a not-yet-onboarded OAuth
  client) to `stella:admin_write`. **Breaks least privilege. Keep separate.**
- **A generic `delete_entity`.** delete_document/matter/contact/clause/time_entry live
  under **different write scopes**; a generic delete would need a union of scopes,
  breaking per-domain least privilege. **Reject.**
- **`read_audit_log` into any read tool.** It is fail-closed
  (`excluded: dynamic_tenant_payload`) because its change diffs can embed any tenant
  name. Merging it with an `anonymize` read would either drop it from the anonymized
  surface (fine but pointless) or, if the host tool is exposed, risk leaking the
  un-enumerable diff. **Never merge a fail-closed read into an exposed one.**

---

## 6. Naming / structural inconsistencies found (flag, decide separately)

- **`read_*` vs `list_*` for the same list-or-read-one idiom.** Misnamed as `read_`:
  `read_invoices` (→ `list_invoices`), `read_audit_log` (→ `list_audit_log`, list-only).
  Correctly `list_`: tasks, clauses, playbooks, time_entries. Pure single-item reads
  keep `read_`: read_contact, read_document, read_case_law_decision,
  read_content_across_matters. Renames are free pre-launch but are churn; recommend only
  the two genuinely-misnamed ones.
- **Public-law search scope split.** `search_case_law` is `stella:search` while
  `search_legislation` is `stella:read` (both public-law search). Pick one convention.
  `stella:read` is defensible for the combined search+read legislation tool; if you want
  parity, move search_case_law read-mostly semantics under `stella:read` too. Minor.
- **Contact read/list gap.** `read_contact` (read-one) and `save_contact` exist, but
  there is **no `list_contacts`** — the only collection with no list tool. This is a
  product gap, not a consolidation target; adding a list would cost a slot. Note it;
  don't fix in this PR.
- **`title` (create_document) vs `name` (update_document)** — reconcile to `name` as
  part of M4.

---

## 7. What does NOT change

- **Compat `search` / `fetch`** — external OpenAI connector contract; the one accepted
  duplication.
- **Native search→read split** (search_across_matters + read_content_across_matters).
- **All 4 search tools stay separate** (policy divergence).
- **All 5 `delete_*` standalone**; **read_document** standalone (diff density).
- **Knowledge (5) unchanged**; **billing (6) unchanged** bar the optional
  `read_invoices`→`list_invoices` rename.
- **set_practice_jurisdictions** standalone (onboarding least privilege).
- **manage_organization** multi-action dispatcher, **read_audit_log** fail-closed
  exclusion — both preserved verbatim.
- **Per-domain write scopes** unchanged: every merge stays inside one scope
  (templates→templates, documents_write→documents_write, read→read).
- **Feature flags** unchanged: no merge crosses a flag boundary (e.g. no
  PUBLIC_LAW/TIME_BILLING/USAGE tool is folded into an always-on tool).
- **Anonymized fail-closed decisions** unchanged: no `anonymize`↔`passthrough` or
  `anonymize`↔`excluded` merge occurs.

---

## 8. Risks

- _*Denser save_* schemas (M3, M4)._* The model must learn "omit id ⇒ create,
  create-only vs update-only fields." _Mitigant:_ five existing `save_*` tools already
  teach this exact pattern — consolidation makes the surface **more** uniform, which
  helps the LLM more than the extra optional fields hurt. The `fieldsOverlayProp` union
  in save_template is genuinely complex, but that complexity **already exists** in both
  parts; merging de-duplicates rather than adds it.
- **Dual-mode list tools (M1, M2).** `list_matters`/`list_templates` must return two
  output shapes. Precedent: list_tasks/list_clauses. Low risk. The egress pipeline must
  tolerate declared textFields that are absent in list-mode payloads — it already skips
  null/empty, and the registry test only asserts the union is non-empty (it is). Add a
  test that exercises both modes through egress.
- **Where a merge would hurt the model, we recommended against it** (§5): read_document,
  read_case_law_decision, the search family. That is the deliberate keep-simple bias.
- **Rename churn (M-renames, §6).** Snapshot + `tools.test.ts` churn only; safe
  pre-launch, but skip low-value renames to avoid noise.
- **Ratchet direction.** After the merges, lower `TOOL_COUNT_CEILING.default`
  45 → 41 and `.anonymized` 24 → 22 (per the suite's ratchet philosophy) so future
  unreviewed growth fails. Keep **45 documented as the hard product cap**; the recovered
  slots are headroom below it.

---

## 9. Phased implementation

Each merge touches: (a) the tool definition (drop one, extend the survivor's schema),
(b) the survivor's handler (add the create-vs-update / list-vs-detail branch — this is
real handler work, not just schema), (c) `MCP_TOOL_HANDLERS` in `tools.ts`, (d)
snapshots (`registry-quality.test.ts` snapshot, `tools.test.ts`, and the
`template-tools.test.ts` / document / matter suites).

**Single PR is feasible** (all under `apps/api/src/mcp/*`, pre-launch, no client
migration). For a solo maintainer with snapshot churn, prefer **three review-sized PRs**:

1. **Templates** — M2 (`describe_template`→`list_templates`) + M3 (`save_template`).
   Biggest char win, self-contained, and the `template-tools.test.ts` suite is already
   large so its churn is localized.
2. **Documents + matters** — M4 (`save_document`) + M1 (`list_matters`←overview).
3. **Optional** — M5 (`template_marker_reference`→resource) + the two `read_*`→`list_*`
   renames + ceiling ratchet. Land last, lowest risk.

Snapshot/test churn is the main cost and is entirely mechanical (regenerate the
registry-quality snapshot; update per-tool call tests). No migration, no runtime data
changes.

---

## 10. Recommendation and outcome

The original recommendation was M1–M4 with M5 and the renames optional. The
maintainer approved the full sweep (M1–M5 plus both renames), and this branch
implements all of it: 40 tools, marker reference served as an MCP resource, and
`list_invoices`/`list_audit_log` names. **Not touched, by design**: the search
family, read_document, and set_practice_jurisdictions — those separations are
load-bearing (egress policy, schema density, least privilege). Net result: the
surface is **more uniform, not just smaller**, with 5 slots of headroom under
the hard 45 ceiling before MCP launches.
