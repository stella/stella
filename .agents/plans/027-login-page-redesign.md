# Plan: Login Page Redesign

Date: 2026-03-26

## Goal

Redesign the auth pages from a bare centered card to a two-column
layout with brand headline on the left and form on the right.
Inspired by Claude.ai's login: big display headline, subtitle,
wordmark, dark and clean. Target audience: returning users at
mid-size law firms (5-50 lawyers).

## Design Decisions

- **Two-column layout, not single column**: the current centered
  card looks like a dev placeholder. A split layout gives the
  brand visual weight and makes the page feel intentional. On
  mobile, collapses to single column with logo + headline above
  the form.

- **"Clarity for every case." as headline**: speaks directly to
  the ICP's daily concern (organized matters, findable documents).
  Double meaning with legal "case." Aligns with brand principle
  #1 ("clarity, not magic").

- **Subtitle: "Open-source legal workspace with AI-powered
  review."**: one line that says what Stella is. No pricing on
  the login page (returning users already know it; price is a
  closing argument for www).

- **No SSO buttons**: Will
  use email-first domain discovery when implemented. Login page
  stays email + OTP only.

- **Shared auth layout route**: all 4 auth pages (`index`,
  `otp`, `organization`, `accept-invitation`) currently duplicate
  the same wrapper. Extract to a parent route layout so the
  two-column structure is defined once.

- **Value props not shared with www**: different audience
  (returning users vs. prospects), different depth. The login
  headline is atmospheric brand reinforcement, not a feature
  list.

## Scope

**In scope:**

- Shared auth layout with two-column responsive design
- Left panel: StellaWordmark + display headline + subtitle
- i18n keys for headline + subtitle (all 12 languages)
- Mobile responsive (single column, logo above form)
- All 4 auth routes render inside the new layout

**Out of scope:**

- SSO buttons / Google / Microsoft sign-in
- Product screenshot or illustration on the right
- www landing page changes
- Auth flow changes (stays email OTP)

## Implementation

- `apps/web/src/routes/auth/route.tsx` — new shared auth layout
  with two-column grid. Left panel renders headline + wordmark,
  right panel renders `<Outlet />` (child route content).
- `apps/web/src/routes/auth/index.tsx` — remove the outer
  `flex-1 items-center justify-center` wrapper (now handled by
  layout). Keep Form + Frame as-is.
- `apps/web/src/routes/auth/otp.tsx` — same: remove outer wrapper.
- `apps/web/src/routes/auth/organization.tsx` — same.
- `apps/web/src/routes/auth/accept-invitation.$invitationId.tsx`
  — same.
- `apps/web/src/i18n/langs/*.json` — add `auth.headline` and
  `auth.subtitle` keys in all 12 languages.
- `apps/web/src/i18n/langs/messages.gen.ts` — add type entries.

## Test Cases

- Visual: two-column on desktop (>768px), single column on mobile
- All 4 auth routes render correctly inside the layout
- i18n: headline/subtitle switch with locale
- Dark mode: semantic tokens work (no hardcoded colors)
- No layout shift or CLS on page load

## Open Questions

None — design is approved, scope is minimal.
