# 011 - Audit Log (SOC 2 CC7.2 / ISO A.12.4)

## Status: Phase 1 in progress

## Problem

State-changing operations on core resources are not logged. SOC 2
CC7.2 and ISO 27001 A.12.4 require an audit trail that ties every
mutation to an actor and timestamp.

## Design Decisions

- No FK on `workspaceId` / `userId`: audit records must survive
  resource deletion. `organizationId` cascades on organization
  deletion.
- Transactional writes: audited DB mutations write their audit rows
  in the same transaction before commit. If the audit insert fails,
  the mutation rolls back with it.
- Request fingerprinting: handlers build an `AuditContext` from the
  request. Logs include IP-related headers and User-Agent in metadata.
- Diff-shaped changes: updates store `{ old, new }` pairs.
- Cursor pagination: reads use keyset pagination over `(createdAt,
  id)`.
- Indexed resource filters: resource lookups require `resourceType`
  with `resourceId`.
- Handler-level calls: each handler calls `writeAuditLog()` explicitly
  after a successful mutation, because handlers need resource-specific
  IDs and diffs.

## Phase 1

- Entities: create, delete, rename, move, upload, duplicate.
- Workspaces: create, update, delete.
- Properties: create, update, delete.
- Audit read endpoint with org-scoped permission and cursor
  pagination.

## Later Phases

- Phase 2: time entries, expenses, invoices, billing codes, rates.
- Phase 2 infrastructure: retention worker based on firm policy and
  jurisdiction.
- Phase 3: contacts, templates, clauses, views, fields, organization
  settings.
