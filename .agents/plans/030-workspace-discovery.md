# Plan: Workspace Discovery + Smart Invites

Date: 2026-04-01

## Goal

Three related features that use email domain intelligence to
reduce friction and increase security during onboarding:

1. **Workspace discovery**: detect existing orgs with the same
   email domain and let new users request to join
2. **Colleague suggestions**: on the invite step, suggest other
   stella users with the same email domain
3. **Domain mismatch warning**: warn when inviting someone with
   a different email domain ("Are you sure? This user will see
   your documents.")

## Design Decisions

### Workspace Discovery

- **Non-generic domain check.** Maintain a list of generic
  email providers (gmail.com, outlook.com, yahoo.com, seznam.cz,
  hotmail.com, etc.) and skip the check for those.

- **Notification, not auto-join.** The new user sends a
  request; the existing admin approves or ignores. This
  respects workspace ownership and avoids unauthorized access
  to privileged legal data.

- **Show during onboarding.** After auth, if we detect a
  matching organization, show a card before the team-name step:
  "It looks like colleagues at {domain} already use stella.
  Request to join their workspace?"

- **Admin notification.** Email to the org owner/admin:
  "{name} ({email}) wants to join {org}. Approve or ignore."
  Include an approve link that adds the user as a member.

### Colleague Suggestions

- **Backend endpoint.** `GET /users/by-domain?domain=kubica.cz`
  returns users with the same email domain who are NOT already
  members of the current org. Requires auth; only returns
  name + email (no sensitive data).

- **Show on invite step.** Below the email input, show a
  section: "People at kubica-partners.cz already on stella:"
  with clickable email chips. Click to add to invite list.

- **Privacy.** Only show to users with the same domain. Never
  expose users across domains. Consider: should we show full
  names or just emails?

### Domain Mismatch Warning

- **Frontend-only.** Extract the domain from the current user's
  email. When an invited email has a different domain, show a
  subtle warning below the chip: "External collaborator — they
  will have access to your documents."

- **Not blocking.** The warning is informational, not a gate.
  External collaborators are a legitimate use case (opposing
  counsel, clients, experts).

- **Color coding.** External email chips could have a different
  background (e.g., `bg-warning/10` with an icon) to visually
  distinguish them from same-domain colleagues.

## Implementation

### Backend

- `apps/api/src/handlers/users/by-domain.ts` — new endpoint
  for colleague suggestions. Scoped to authenticated users;
  returns users matching the caller's email domain.
- `apps/api/src/handlers/organizations/join-request.ts` —
  new endpoint for workspace discovery. Creates a join request
  record and triggers admin notification email.
- Generic domain allowlist: hardcoded constant or config file
  with ~50 common providers.

### Frontend

- Invite step: domain mismatch warning (pure frontend, no API)
- Invite step: colleague suggestions section (needs backend)
- Onboarding: workspace discovery card (needs backend)

### Database

- `join_requests` table: `id`, `userId`, `organizationId`,
  `status` (pending/approved/rejected), `createdAt`

## Scope

**In scope (v1 — frontend only, no backend):**

- Domain mismatch warning on invite step
- Visual distinction for external email chips

**In scope (v2 — needs backend):**

- Colleague suggestions on invite step
- Workspace discovery during onboarding
- Admin notification email
- Join request approval flow

**Out of scope:**

- Auto-join based on email domain (security risk)
- SSO/SAML domain verification
- Multiple orgs with the same domain (show first match)
- Admin dashboard for managing join requests

## Open Questions

- How aggressively should we match? Exact domain only, or
  also subdomains (`legal.kubica.cz` → `kubica.cz`)?
- Should colleague suggestions show names or just emails?
- Rate limit on join requests to prevent spam?
