# Plan: Custom Subdomains

Date: 2026-04-01

## Goal

Enable `slug.stll.app` subdomains so each organization gets a
branded URL (e.g., `kubica.stll.app`). Table stakes for a
serious SaaS; signals "this is YOUR space" to law firms.

## Design Decisions

- **Wildcard DNS + Cloudflare universal SSL.** One DNS record
  (`*.stll.app → CNAME`), Cloudflare handles cert issuance.
  No per-org cert management.

- **Middleware-based routing.** A lightweight middleware reads
  the subdomain from the `Host` header, maps it to an org via
  slug lookup, and sets the org context. ~50 lines of code.

- **Cookie domain on `.stll.app`.** Session cookies must be
  scoped to `.stll.app` (with leading dot) so they work across
  the root domain and all subdomains. Verify better-auth
  supports this.

- **Slug uniqueness validation during onboarding.** Call
  `authClient.organization.checkSlug` before creating the org.
  Show inline error if taken. The current `createSlug` appends
  a timestamp suffix which makes collisions unlikely but not
  impossible.

- **Show subdomain preview in onboarding.** Once subdomains
  work, re-add `slug.stll.app` preview below the team name
  input. Only show after the feature is deployed.

- **Dev environment.** `localhost` doesn't support subdomains.
  Options: use `lvh.me` (resolves to 127.0.0.1), or add
  `*.stll.local` to `/etc/hosts`, or skip subdomain routing
  in dev and use path-based routing as fallback.

## Scope

**In scope:**

- Wildcard DNS record for `*.stll.app`
- Middleware: subdomain → org context mapping
- Cookie domain configuration for `.stll.app`
- Slug uniqueness check during onboarding
- Redirect from `stll.app/workspaces` to `slug.stll.app`
  after org is resolved
- Subdomain preview in onboarding org step (re-add)

**Out of scope:**

- Custom domains (e.g., `legal.kubica.cz`) — much harder,
  needs per-domain cert issuance, DNS verification
- Subdomain for self-hosted deployments
- Marketing pages on subdomains

## Implementation

- **DNS:** Add `*.stll.app` CNAME to Cloudflare
- **API middleware:** `apps/api/src/middleware/subdomain.ts`
  — extract subdomain from Host, lookup org by slug, inject
  into request context
- **Auth config:** Set cookie domain to `.stll.app` in
  better-auth config (`apps/api/src/lib/auth.ts`)
- **Frontend:** Detect subdomain in `__root.tsx` `beforeLoad`,
  auto-set active org if subdomain matches
- **Onboarding:** Re-add slug preview, add `checkSlug` call
  before org creation

## Open Questions

- Should the root `stll.app` redirect to the user's org
  subdomain, or keep working as a "neutral" entry point?
- Should we strip the timestamp suffix from slugs (currently
  `kubica-partners-1712345678`) to make them cleaner
  (`kubica-partners`)?
