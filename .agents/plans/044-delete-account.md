# Plan: Delete Account Settings

Date: 2026-06-13

## Goal

Allow users to delete their account from the settings page, verified via a one-time password (OTP) sent to their email. The flow prevents deleting the account if they are the sole owner of any organization. Additionally, it implements a task handoff/offboarding step to allow reassigning pending tasks to other members of their workspaces before deletion.

## Design Decisions

- **OTP Verification**: Verifies deletion intent using a 6-digit OTP code stored in the `verification` table.
- **Sole Organization Owner Check**: Blocks deletion if the user is the only owner of an organization to prevent leaving organizations without active administrators.
- **Task Offboarding (Reassignment)**: Fetches all pending tasks where the user is an assignee and allows reassigning them to other members of the same workspaces. This is executed atomically within the delete account transaction.
- **Compliance & DMS Integrity**: Preserves organization-scoped data (files, workspaces, audit logs) while removing personal user credentials, sessions, and memberships.

## Scope

**In scope:**
- Backend endpoints: `/v1/me/delete/send-otp`, `/v1/me/delete/pending-tasks` [NEW], and `/v1/me/delete/verify`.
- Checking organizational ownership status before OTP generation.
- Reassigning pending tasks to selected workspace members.
- Anonymizing the user record and clearing associated credentials/sessions.
- Frontend Danger Zone UI with task reassignment step, confirmation dialog, and OTP input.

**Out of scope:**
- "Export my data" zip job.

## Implementation

- `apps/api/src/lib/delete-account.ts` [MODIFY] — Add task fetching/reassignment helper functions.
- `apps/api/src/handlers/me/routes.ts` [MODIFY] — Route declarations.
- `apps/api/src/handlers/me/pending-tasks.ts` [NEW] — Retrieve pending tasks and potential assignees.
- `apps/api/src/handlers/me/send-otp.ts` [MODIFY] — Ownership check & OTP email sender.
- `apps/api/src/handlers/me/verify-delete.ts` [MODIFY] — Accept reassignments and trigger deletion.
- `apps/web/src/routes/_protected.settings/account.profile.tsx` [MODIFY] — Add task reassignment step in Danger Zone deletion flow.
- `apps/web/src/i18n/langs/en.json` [MODIFY] — English translations for task reassignment labels.

## Test Cases

- Attempt deletion when user is sole owner of an organization: Verify blocked with an error.
- Verify pending tasks are correctly loaded and mapped to workspace members.
- Complete deletion flow with reassigned tasks: Verify those tasks are reassigned to the selected users, other tasks are cleared of assignees, and account is anonymized.
