# Plan: Document Types Management

Date: 2026-07-06

## Goal

Give orgs a central place to define and edit the `document_types` taxonomy
(add / rename / reorder / delete), instead of the current read-only,
seed-only list. One editable source of truth feeds both playbook scoping and
the "Document Type" classifier.

## Background (current state)

- `document_types` table is org-owned (`key`, `label`, `sortOrder`), unique on
  `(organization_id, key)`, RLS via `orgPolicies()`. Lazily seeded from
  `DEFAULT_DOCUMENT_TYPES` (20 entries) on first read.
- Exposed **read-only**: `GET /document-types` → `{ items: [{ id, key, label,
  sortOrder }] }`. No write path anywhere.
- Two consumers of the taxonomy:
  - **Playbook scoping**: `playbook.scope.documentTypeKey` stores the stable
    `key` (JSONB, not a FK).
  - **"Document Type" classifier**: a per-workspace single-select AI property
    matched by `name = 'document type'`. `materialize-run` resolves a
    playbook's `key → label` and gates materialized columns on the classifier's
    value.

## Design Decisions

- **Location: org Settings page + in-context link.** The taxonomy is org-owned
  and shared across all workspaces, so it belongs in org Settings
  (`/settings/organization/document-types`), alongside anonymization /
  matter-numbering. A "Manage types…" link from the playbook editor's Type
  picker makes it reachable in the authoring flow. Closest existing analog:
  `organization.anonymization.tsx` + `handlers/organization-settings/*`.

- **`key` is immutable after create.** `key` is the identity that playbook
  JSONB scopes and (historically) classifier values reference. Editing it would
  silently orphan those references, so create derives `key` = slug(`label`) once
  and updates only ever touch `label` / `sortOrder`. This makes a whole class of
  orphaned-scope bugs structurally impossible rather than validated at runtime.

- **Delete is guarded, not cascading.** Before delete, check whether any
  playbook scopes the `key` (JSONB `scope->>'documentTypeKey'` predicate, same
  shape `route-playbooks.ts` already uses). If in use → block (409 + the
  referencing playbook names) so the user reassigns first. Already-classified
  documents keep their stored classifier label (free-form single-select value);
  delete only removes the type as a *future* option — call this out in the UI.

- **Reorder via `sortOrder`, drag-and-drop.** Reuse the in-repo
  `@atlaskit/pragmatic-drag-and-drop` pattern (same as the playbook position
  list) for consistency.

- **Mutations are audited.** The read handler intentionally skips audit (system
  bootstrap seed). User-initiated create/rename/delete/reorder are org-config
  changes and must record audit events (SOC2/ISO posture), unlike the seed.

- **Keep default seeding.** `ensureDefaultDocumentTypes` stays for new-org
  provisioning; optionally expose a "restore defaults" action (adds any missing
  default keys, idempotent — never overwrites edits).

## Scope

**In scope:**

- Write endpoints under `handlers/document-types/`: create, update (label +
  sortOrder), delete (guarded), reorder (batch sortOrder). Root-scoped via
  `createSafeRootHandler` + `session.activeOrganizationId`; org-admin gated.
- Org Settings page: list + inline rename, add, DnD reorder, guarded delete;
  registered in the settings nav (`route.tsx`).
- "Manage types…" link from the playbook editor Type picker.
- Query layer + typed `TranslationKey` copy across locales.

**Out of scope:**

- Auto-re-syncing existing per-workspace "Document Type" classifier columns when
  the taxonomy changes (see Open Questions).
- Changing how classification runs or how playbooks resolve keys.
- Per-matter/per-workspace type overrides — the taxonomy stays org-level.
- Migrations — the table already exists.

## Implementation

- `apps/api/src/handlers/document-types/create.ts` — `{ config, handler }`,
  slug the `label` → `key`, unique-per-org (suffix on collision or 409),
  `LIMITS.documentTypesCount` cap, audit event.
- `apps/api/src/handlers/document-types/update-by-id.ts` — label / sortOrder
  only; never `key`. Valibot/Elysia body at the boundary.
- `apps/api/src/handlers/document-types/delete-by-id.ts` — in-use guard against
  `playbook_definitions.scope`, audit event.
- `apps/api/src/handlers/document-types/reorder.ts` (or fold into update) —
  batch `sortOrder` for a set of ids, single tx.
- `apps/api/src/handlers/document-types/routes.ts` — add POST / PATCH / DELETE /
  reorder to the existing GET.
- `apps/web/src/routes/_protected.settings/organization.document-types.tsx` —
  the page; `-queries/document-types.ts` for options + mutations.
- `apps/web/src/routes/_protected.settings/route.tsx` — add the nav item + `to`
  union entry; new `settings.organization.documentTypes` i18n key.
- `apps/web/src/routes/_protected.knowledge/-components/playbook-editor.tsx` —
  "Manage types…" link near the Type picker.
- `routeTree.gen.ts` — regenerate for the new route before CI.
- No schema/migration changes.

## Test Cases

- Create slugs the label, dedupes `key` per org, and rejects at the count cap.
- Update changes label/sortOrder but cannot change `key` (rejected/ignored).
- Delete of an **in-use** type is blocked and names the referencing playbook(s);
  delete of an unused type succeeds and leaves historical classifier values on
  already-classified docs intact.
- Reorder persists `sortOrder` and the list reads back in the new order.
- Org isolation: an org cannot read or mutate another org's types (RLS +
  `activeOrganizationId`).
- Playbook scoped to a still-existing key continues to route after unrelated
  taxonomy edits.

## Open Questions

- **Classifier option re-sync.** When the taxonomy changes, do we update the
  option set of *existing* per-workspace "Document Type" classifier columns, or
  only influence newly-created ones? Recommendation: **no auto-resync in v1** —
  routing already matches by resolved label, so drift is tolerable; a later
  "sync classifier options" action can reconcile. Needs a quick check of where
  the classifier property's options are stored/derived to confirm the blast
  radius.
- **Permission scope.** Which role can manage the taxonomy — Owner/Admin only,
  or any member? Lean Owner/Admin (org config), matching other org-settings
  pages.
