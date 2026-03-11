# 005 — Matter Reference Numbering

## Context

Stella workspaces (called "matters" in the UI) currently have
only a name and a nanoid PK. Law firms universally assign
structured reference numbers to cases (e.g., 2026/001,
LIT-0042). These numbers appear on every document, invoice,
and court filing. Without them, Stella is not a credible legal
workspace. This feature adds configurable, auto-generated
matter reference numbers with great UX.

Inspired by j-lawyer-org's CaseNumberGenerator, but using a
counter-per-scope table instead of scanning all existing numbers.

---

## 1. Schema Changes

**File:** `apps/api/src/db/schema.ts`

### 1a. Add `reference` column to `workspaces`

```ts
reference: p.varchar({ length: 64 }),
```

Plus unique index:

```ts
p.uniqueIndex("workspaces_org_reference_uidx")
  .on(table.organizationId, table.reference),
```

Nullable so existing workspaces migrate cleanly. New workspaces
always get a reference.

### 1b. New `matterCounters` table

```ts
export const matterCounters = p.pgTable(
  "matter_counters",
  {
    id: pNanoid.primaryKey(),
    organizationId: p
      .varchar("organization_id", { length: 128 })
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    scopeKey: p.varchar("scope_key", { length: 128 }).notNull(),
    lastValue: p.integer("last_value").notNull().default(0),
  },
  (table) => [
    p
      .uniqueIndex("matter_counters_org_scope_uidx")
      .on(table.organizationId, table.scopeKey),
  ],
);
```

One row per (org, scope). Scope derives from the rendered
static prefix of the pattern (see section 2b).

### 1c. New `organizationSettings` table

```ts
export const organizationSettings = p.pgTable("organization_settings", {
  id: pNanoid.primaryKey(),
  organizationId: p
    .varchar("organization_id", { length: 128 })
    .notNull()
    .unique()
    .references(() => organization.id, { onDelete: "cascade" }),
  matterNumberPattern: p
    .varchar("matter_number_pattern", { length: 128 })
    .notNull()
    .default("{SEQ}"),
  matterNumberPadding: p.integer("matter_number_padding").notNull().default(3),
  updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
});
```

1:1 with organization. Separate from organization table
because that table is managed by better-auth.

Push all three changes with `bun drizzle-kit push`.

---

## 2. Pattern System

### 2a. Token language

| Token  | Output        | Example |
| ------ | ------------- | ------- |
| {SEQ}  | Padded seq    | 001     |
| {YYYY} | 4-digit year  | 2026    |
| {YY}   | 2-digit year  | 26      |
| {MM}   | 2-digit month | 02      |

Everything else is a literal character. Examples:

| Pattern             | Pad | Result        |
| ------------------- | --- | ------------- |
| `{SEQ}`             | 3   | 001           |
| `{YYYY}/{SEQ}`      | 3   | 2026/001      |
| `{YYYY}-{MM}/{SEQ}` | 3   | 2026-02/001   |
| `LIT-{SEQ}`         | 4   | LIT-0001      |
| `CORP-{YYYY}-{SEQ}` | 3   | CORP-2026-001 |

### 2b. Scope key derivation

Scope key = pattern with date tokens resolved, `{SEQ}` removed.

- `{YYYY}/{SEQ}` on 2026-02-20 → scope `"2026/"`
- `{YYYY}-{MM}/{SEQ}` → scope `"2026-02/"`
- `LIT-{SEQ}` → scope `"LIT-"`
- `{SEQ}` → scope `""`

When the year/month rolls over, a new scope row is created
and the counter starts from 1 again. Natural reset behavior.

### 2c. Validation rules

1. Must contain exactly one `{SEQ}`.
2. Only recognized tokens (`{SEQ}`, `{YYYY}`, `{YY}`, `{MM}`).
3. Max 128 characters.
4. No `<`, `>`, `&` characters.
5. Padding between 1 and 6.

### 2d. Defaults

New orgs with no settings row: `{SEQ}`, padding 3.
First workspace gets `001`. No onboarding step required.

---

## 3. Backend

### 3a. New file: `apps/api/src/lib/matter-reference.ts`

Pure functions (no DB, easy to test):

- `toScopeKey(pattern: string, now: Date): string`
  Renders all tokens except `{SEQ}`.
- `toReference(scopeKey: string, seq: number, padding: number): string`
  Renders scope key + padded sequence number.
- `validatePattern(pattern: string): Result<true, PatternError>`
  Validates the pattern string.

### 3b. New handlers: `apps/api/src/handlers/organization-settings/`

| Route                               | Method | Handler    | Auth        |
| ----------------------------------- | ------ | ---------- | ----------- |
| `/v1/organization-settings/`        | GET    | read.ts    | Any member  |
| `/v1/organization-settings/`        | POST   | update.ts  | Admin/owner |
| `/v1/organization-settings/preview` | POST   | preview.ts | Admin/owner |

**read:** Returns current settings or defaults if no row exists.

**update:** Validates pattern, upserts `organizationSettings` row.

**preview:** Renders what the next reference would look like
without allocating a number. Used by the settings UI for live
preview. Accepts `{ pattern, padding }` in body; returns
`{ preview: string, nextValue: number }`.

### 3c. Modified: `apps/api/src/handlers/workspaces/create.ts`

Inside the existing transaction, after name deduplication:

1. Read org settings (or use defaults).
2. Compute scope key from pattern + `new Date()`.
3. Atomic counter increment:

```ts
const [counter] = await tx
  .insert(matterCounters)
  .values({
    id: nanoid(),
    organizationId,
    scopeKey,
    lastValue: 1,
  })
  .onConflictDoUpdate({
    target: [matterCounters.organizationId, matterCounters.scopeKey],
    set: {
      lastValue: sql`${matterCounters.lastValue} + 1`,
    },
  })
  .returning({ lastValue: matterCounters.lastValue });
```

4. Render reference: `toReference(scopeKey, counter.lastValue, padding)`.
5. Insert workspace with `reference` set.

All atomic within the transaction. If insert fails, counter
is not consumed.

### 3d. Route registration

Register `organizationSettingsRoute` in the main Elysia app
file alongside other routes. Guard with `validateAuth`.

---

## 4. Frontend

### 4a. Sidebar (`apps/web/src/components/app-sidebar.tsx`)

Update `MatterItem` to show reference below the name:

```tsx
<Link ...>
  <MatterDot id={ws.id} />
  <span className="flex flex-col">
    <span>{ws.name}</span>
    {ws.reference && (
      <span className="text-[0.625rem] font-mono
        text-muted-foreground leading-tight
        opacity-60 group-hover/sidebar-menu-button:opacity-100
        transition-opacity duration-200">
        {ws.reference}
      </span>
    )}
  </span>
</Link>
```

Collapsed sidebar tooltip: `"2026/001 - Smith v. Jones"`.

### 4b. Workspace cards (`apps/web/src/routes/_protected.workspaces/index.tsx`)

Show reference next to the name in monospace font:

```tsx
<h1 className="text-lg font-bold">{workspace.name}</h1>;
{
  workspace.reference && (
    <span className="text-sm font-mono text-muted-foreground">
      {workspace.reference}
    </span>
  );
}
```

### 4c. Organization settings (`apps/web/src/routes/_protected.organization/route.tsx`)

Add a "Matter numbering" section to the settings dialog:

1. **Pattern selector:** `<Select>` with presets:
   - "Sequential (001)" = `{SEQ}`
   - "Year / Sequential (2026/001)" = `{YYYY}/{SEQ}`
   - "Year-Month / Sequential (2026-02/001)" = `{YYYY}-{MM}/{SEQ}`
   - "Custom..." = text input
2. **Padding selector:** `<Select>` with options 2–6, default 3.
3. **Live preview:** Debounced call to preview endpoint, shows
   next reference in a bordered box with monospace font.
4. Token help text below the input.

### 4d. New queries

Create `apps/web/src/routes/_protected.organization/-settings-queries.ts`
for org settings (read, preview). Follow existing query key
factory pattern.

### 4e. Translations (`apps/web/src/i18n/locales/en.json`)

Add keys under `organization.matterNumber`:

- `title`, `description`, `pattern`, `padding`,
  `paddingDescription`, `nextPreview`
- `presets.sequential`, `presets.yearSequential`,
  `presets.yearMonthSequential`, `presets.custom`
- `tokenHelp`, `patternRequired`, `patternMustContainSeq`,
  `patternInvalidTokens`

After editing, run `bun packages/scripts/src/i18n-typegen.ts`.

---

## 5. UX Details

- **Zero config:** Works out of the box with sequential `001`.
- **Live preview:** Settings show next number as you change
  the pattern. No guesswork.
- **Monospace font:** Reference always in `font-mono` to signal
  "structured identifier" vs free-text name.
- **Subtle sidebar:** Reference at 60% opacity, fades to 100%
  on hover (`transition-opacity duration-200`).
- **Immutable:** No edit button for reference. Once assigned,
  it never changes.
- **Existing workspaces:** Keep null reference. No retroactive
  numbering (would confuse firms).

---

## 6. Implementation Order

1. Schema: all three changes, push with drizzle-kit
2. `matter-reference.ts`: pure functions + tests
3. Organization settings handlers (read, update, preview)
4. Workspace creation handler modification
5. Frontend sidebar + cards (display reference)
6. Frontend org settings UI (pattern configuration)
7. Translations (`en.json`, then `i18n-typegen.ts`)

---

## 7. Files to Create

| Path                                                     | Purpose                                      |
| -------------------------------------------------------- | -------------------------------------------- |
| `apps/api/src/lib/matter-reference.ts`                   | Pattern parsing, scope derivation, rendering |
| `apps/api/src/handlers/organization-settings/read.ts`    | GET settings                                 |
| `apps/api/src/handlers/organization-settings/update.ts`  | POST upsert settings                         |
| `apps/api/src/handlers/organization-settings/preview.ts` | POST preview next ref                        |
| `apps/api/src/handlers/organization-settings/routes.ts`  | Elysia route group                           |

## 8. Files to Modify

| Path                                                    | Change                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/api/src/db/schema.ts`                             | Add `reference` col, `matterCounters`, `organizationSettings` tables |
| `apps/api/src/handlers/workspaces/create.ts`            | Add reference generation inside transaction                          |
| `apps/api/src/index.ts`                                 | Register new routes                                                  |
| `apps/web/src/components/app-sidebar.tsx`               | Show reference in MatterItem                                         |
| `apps/web/src/routes/_protected.workspaces/index.tsx`   | Show reference on cards                                              |
| `apps/web/src/routes/_protected.organization/route.tsx` | Add numbering config to settings                                     |
| `apps/web/src/i18n/locales/en.json`                     | Add translation keys                                                 |

---

## 9. Verification

1. `bun drizzle-kit push` succeeds
2. Create a workspace; it gets reference `001`
3. Create another; it gets `002`
4. Change pattern to `{YYYY}/{SEQ}` in org settings
5. Create workspace; it gets `2026/001`
6. Sidebar shows reference below name, fades on hover
7. Workspace cards show reference in monospace
8. Preview in settings updates live as you type
9. Collapsed sidebar tooltip shows `"2026/001 - Name"`
10. Restart server; next workspace continues from correct counter
