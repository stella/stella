# Plan: Delete Account Settings

Date: 2026-06-08

## Goal

Allow users to delete their account from the settings page, verified via a one-time password (OTP) sent to their email. The flow prevents deleting the account if they are the sole owner of any organization.

## Design Decisions

- **OTP Verification**: Verifies deletion intent using a 6-digit OTP code stored in the `verification` table. This prevents accidental deletion.
- **Sole Organization Owner Check**: Blocks deletion if the user is the only owner of an organization to prevent leaving organizations without active administrators.
- **Compliance & DMS Integrity**: Preserves organization-scoped data (files, workspaces, audit logs) while removing personal user credentials, sessions, and memberships.

## Scope

**In scope:**
- Backend endpoints: `/v1/me/delete/send-otp` and `/v1/me/delete/verify`.
- Checking organizational ownership status before OTP generation.
- Sending transactional email with the OTP.
- User deletion using `better-auth` APIs.
- Frontend Danger Zone section with confirmation dialog and OTP input.

**Out of scope:**
- "Export my data" zip job (mentioned as a future step in settings file comment).

## Implementation

- `apps/api/src/handlers/me/routes.ts` [NEW] — Route declarations.
- `apps/api/src/handlers/me/send-otp.ts` [NEW] — Ownership check & OTP email sender.
- `apps/api/src/handlers/me/verify-delete.ts` [NEW] — Verification and user deletion logic.
- `apps/api/src/index.ts` [MODIFY] — Register the new routes.
- `packages/transactional/emails/better-auth-otp.tsx` [MODIFY] — Add `"delete-account"` OTP type.
- `packages/transactional/i18n/langs/en.json` [MODIFY] — Add English translations for the email.
- `apps/web/src/routes/_protected.settings/account.profile.tsx` [MODIFY] — Danger Zone UI and state.

## Test Cases

- Attempt deletion when user is sole owner of an organization: Verify blocked with an error.
- Successfully request OTP, receive code, verify code, verify user is removed from DB.

## Open Questions

None.
