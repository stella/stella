# Plan: Onboarding Wizard

Date: 2026-03-31

## Goal

Replace the bare "create organization" form with a guided,
multi-step onboarding wizard for first-time users. Inspired by
10xapp/core-oss's flow: welcome splash, split-layout steps with
a live sidebar preview, and a creation progress screen. Adapted
for Stella's legal workspace domain, existing better-auth org
model, and i18n infrastructure.

## Design Decisions

- **5-step wizard, not 6.** The welcome splash and the
  "setting up" animation are bookend screens; the three
  productive steps are organization, first matter, and invite
  team. A profile step is unnecessary: better-auth already
  captures the user's name during sign-up, and avatar upload
  is a settings concern (not a first-run blocker). Fewer steps
  means faster time-to-value for busy lawyers.

- **Organization step: name only, slug hidden.** Slugs are a
  developer concept; lawyers shouldn't see them. Auto-derive
  the slug from the name (reuse existing `createSlug`), show
  it as a subtle URL preview below the input ("Your workspace
  URL: stella.app/kubica-partners") but don't expose an
  editable slug field. Power users can change it in org
  settings later.

- **Split layout with live sidebar preview** for the three
  middle steps. Left half: white, form content. Right half:
  `bg-muted` with a simplified sidebar mock built from plain
  styled divs (not real `AppSidebar` components). Shows the
  StellaWordmark, org name, a "Matters" heading, and the
  matter name — all updating live as the user types. Hidden
  on mobile (`hidden md:flex`).

- **Welcome document in the first matter.** During the
  "setting up" step, auto-create a brief "Getting Started"
  markdown note in the new matter so the user lands on
  something real, not an empty shell. Content: brief
  orientation ("This is your first matter. Upload documents,
  invite your team, use AI review.") with links to docs.
  Without this, the wizard ends on a dead-end empty state.

- **CSS transitions, not Framer Motion.** We don't have
  `motion` as a dependency and adding 30kB for 3 slide
  animations isn't justified. Use CSS `@starting-style` +
  `transition` for enter/exit, or a lightweight
  `useTransitionState` hook wrapping `requestAnimationFrame`.

- **`onboardingCompletedAt` on the `user` table.** Nullable
  timestamp column. `null` = needs onboarding. Set once on
  completion. Read by the root route guard to redirect. Stored
  in the session context so it's available without an extra
  query. This matches 10xapp's approach but uses our existing
  better-auth session plumbing.

- **Backfill migration for existing users.** When adding the
  column, set `onboarding_completed_at = now()` for all users
  who already belong to an organization. Without this, every
  existing user would be redirected to the onboarding wizard
  on their next login.

- **Route guard via `beforeLoad` in the root `__root` or
  `_protected` layout.** If `onboardingCompletedAt` is null
  and the user has no organization, redirect to `/onboarding`.
  Post-onboarding navigates with `replace: true` to prevent
  back-button return.

- **Onboarding is mandatory for all deployments.** No env var
  to skip it. Self-hosters who want to bypass can set the
  column directly in the DB (they have DB access). The wizard
  is functional setup, not marketing fluff; even self-hosters
  benefit from creating an org and first matter.

- **Reuse existing org creation logic.** The wizard's org step
  calls `authClient.organization.create` + `setActive`, same
  as the current `/auth/organization` page. The old page
  becomes a fallback for users who already have orgs but need
  to switch (returning users). No backend changes for org
  creation.

- **First-matter step is the differentiator.** 10xapp asks
  for workspace name; we ask for the first matter name. This
  is higher-value: a law firm user immediately sees their
  workflow, not an abstract "workspace." The wizard calls the
  existing `POST /workspaces` endpoint.

- **Invite step uses email chip input, skippable.** Comma,
  semicolon, Enter, Tab, Space all tokenize. Paste splits on
  delimiters. This reuses `authClient.organization.inviteMember`
  (better-auth). The step is fully skippable; solo practitioners
  shouldn't be blocked.

- **All strings via `use-intl`.** New namespace
  `onboarding.*` with keys for each step's heading, subtitle,
  placeholder, and button labels. All 12 supported languages.

- **Progress indicator: 3 bars.** Maps to the 3 split-layout
  steps (organization, first matter, invite). Active = filled
  `bg-foreground`, inactive = `bg-border`. Simple,
  professional, no playful dots.

- **Welcome step: minimal.** No feature list, no value props.
  Just "Welcome to Stella", one-line subtitle, CTA button.
  Professional, not salesy. Lawyers are skeptical of marketing
  speak on a tool they're already evaluating.

## Scope

**In scope:**

- New `/onboarding` route (full-screen, outside `_protected`)
- 5-step wizard component with state machine
- Welcome step (full-screen, StellaGradient background,
  StellaWordmark, heading, CTA button, ToS/Privacy links)
- Organization step (name-only input, auto-derived slug with
  URL preview, live sidebar preview)
- First Matter step (matter name input, sidebar preview
  updates)
- Invite Team step (email chip input, skip option)
- Setting Up step (animated progress bar, rotating status
  messages, auto-creates welcome document)
- Sidebar preview component (styled divs, not real components)
- Progress bar component (3 bars)
- `onboardingCompletedAt` column on `user` table
- Backfill migration: existing users with an org get
  `onboardingCompletedAt = now()`
- Route guard: redirect to `/onboarding` when column is null
  and user has no active organization
- Welcome document auto-created in the first matter
- i18n keys for all 12 languages
- Mobile responsive (single-column, no preview panel)
- PostHog event tracking for each step completion and overall
  funnel

**Out of scope:**

- Avatar upload in onboarding (do it in settings)
- Animated transitions between steps (CSS opacity fade is
  enough for v1; polish later)
- Dark mode for the onboarding screens (the wizard is
  light-only, like the auth pages)
- Onboarding for invited users (they already have an org;
  they skip to the main app — fast follow: lightweight
  "here's how Stella works" tour)
- Product tour / tooltips after onboarding (separate feature)
- Changes to the existing `/auth/organization` page (keep as
  fallback for org switching)
- Env var to skip onboarding for self-hosted

## Implementation

### Database

- `apps/api/src/db/auth-schema.ts` — add
  `onboardingCompletedAt: timestamp("onboarding_completed_at")`
  to the `user` table. Nullable, default null.
- Backfill SQL (run after schema push):
  ```sql
  UPDATE "user" u
  SET onboarding_completed_at = now()
  WHERE EXISTS (
    SELECT 1 FROM member m WHERE m.user_id = u.id
  );
  ```
- Migration via `bun run db:push` + manual backfill.

### Backend

- `apps/api/src/handlers/users/complete-onboarding.ts` — new
  handler: `PATCH /users/onboarding/complete`. Sets
  `onboardingCompletedAt = now()`. Returns 200. No body needed;
  the server sets the timestamp (client can't forge it).
- `apps/api/src/handlers/users/routes.ts` — wire the new
  endpoint.
- Ensure `GET /auth/get-session` (or the better-auth session
  response) includes `onboardingCompletedAt` so the frontend
  can check without an extra round-trip. If better-auth doesn't
  support custom user fields in session, add a separate
  lightweight `GET /users/me` that returns it (or extend the
  existing one).
- Welcome document creation: the "setting up" step calls
  `POST /workspaces` (existing), then a new endpoint or an
  extension of the workspace creation handler that seeds a
  welcome document entity in the new matter.

### Frontend — Route & Guard

- `apps/web/src/routes/onboarding.tsx` — new top-level route.
  `beforeLoad`: redirect to `/` if already completed or if
  user arrived via invitation (has active org). Full-screen
  layout, no sidebar.
- `apps/web/src/routes/__root.tsx` (or `index.tsx`) — extend
  the existing redirect logic: after session + org checks, if
  `onboardingCompletedAt` is null, redirect to `/onboarding`.
- `apps/web/src/routes/auth/organization.tsx` — keep as-is
  for returning users with multiple orgs. The onboarding wizard
  handles first-time org creation.

### Frontend — Components

All under `apps/web/src/routes/onboarding/`:

- `-components/onboarding-wizard.tsx` — state machine
  orchestrator. Holds current step as a discriminated union
  type: `"welcome" | "organization" | "matter" | "invite"
  | "creating"`. Collects form data across steps in a single
  state object. On the final step, executes all API calls in
  sequence (create org → set active → create matter → seed
  welcome document → send invites → complete onboarding),
  then navigates to the new matter with `replace: true`.

- `-components/onboarding-layout.tsx` — the split-layout
  wrapper. Props: `children` (left form), `preview` (right
  panel, optional). Renders the progress bar above the form.

- `-components/onboarding-progress.tsx` — 3 horizontal bars.
  Props: `currentStep: number` (0-2), `totalSteps: 3`.

- `-components/sidebar-preview.tsx` — plain styled divs
  mimicking the sidebar shape. Props: `organizationName`,
  `matterName`, `userName`. Shows StellaWordmark, org name,
  "Matters" heading, matter name. Updates live as user types.
  ~50 lines of JSX, no real sidebar components.

- `-components/steps/welcome-step.tsx` — full-screen centered.
  StellaGradient background. StellaWordmark, heading
  ("Welcome to Stella"), subtitle ("Your legal workspace.
  Let's get you set up."), primary CTA button, ToS/Privacy
  links at the bottom.

- `-components/steps/organization-step.tsx` — single name
  input. Slug auto-derived via `createSlug`, shown as a
  non-editable URL preview below the input. Calls `onNext`
  with `{ name, slug }`.

- `-components/steps/matter-step.tsx` — single input for
  matter name. Placeholder contextual ("e.g., Acme Corp
  Acquisition"). Calls `onNext` with `{ matterName }`.

- `-components/steps/invite-step.tsx` — email chip input
  component. Skip button + Next button. Calls `onNext` with
  `{ emails: string[] }`.

- `-components/steps/creating-step.tsx` — full-screen centered.
  Pulsing StellaWordmark or a simple spinner. Animated progress
  bar (CSS `transition: width`). Rotating status text tied to
  the actual API call in progress ("Creating your
  organization...", "Setting up your first matter...",
  "Almost ready...").

### i18n

- `apps/web/src/i18n/langs/en.json` — add `onboarding.*` keys.
- All 12 language files updated.
- `apps/web/src/i18n/langs/messages.gen.ts` — regenerated.

### Analytics

- PostHog events: `onboarding_started`, `onboarding_step_completed`
  (with `step` property), `onboarding_completed`,
  `onboarding_skipped_invite`.

## Test Cases

- First-time user (no org) is redirected to `/onboarding`
  after auth
- Existing user (onboardingCompletedAt backfilled) is NOT
  redirected after migration
- Invited user (already has org) skips onboarding entirely
- Returning user (onboardingCompletedAt set) is not redirected
- Back button after completion does not return to wizard
- Organization creation with duplicate name shows de-duped
  slug in preview
- Matter creation works and user lands in the new matter
  with a welcome document visible
- Invite step with 0 emails: skip works
- Invite step with 3 emails: all invitations sent
- Mobile: preview panel hidden, form fills full width
- Progress bar reflects current step correctly
- All i18n keys render in at least en + cs

## Success Criteria

- Funnel completion rate (`onboarding_started` →
  `onboarding_completed`) > 90%
- Time from start to completion < 2 minutes
- Users who upload a document in first session > 30%
- No "what do I do now?" support questions from new users
