---
name: click-around
description: 'Autonomous browser-based QA and UX smoke test. Starts the dev server, takes control of Chrome, walks through user stories for a feature area, monitors the console, and produces a structured report on what works, what breaks, and what feels wrong.'
---

# Click Around

Autonomous browser-based QA and UX smoke test. Starts the dev
server, takes control of Chrome, walks through user stories for
a feature area, monitors the console, and produces a structured
report on what works, what breaks, and what feels wrong.

## Arguments

$ARGUMENTS — The feature area to test (e.g., "time tracking",
"invoicing", "document upload"). If empty, ask the user.

## Instructions

### Phase 1: Setup

1. **Start the dev server** using the `/dev` skill flow:
   - Kill stale processes on ports 3000/3001
   - Start API and web servers
   - Wait for both to be ready

2. **Get browser context**:
   - Call `tabs_context_mcp` to see existing tabs
   - If `/dev` already opened a tab to `localhost:3000`,
     use that tab; otherwise create a new one

3. **Start monitoring** — from this point on, after every
   significant browser action, check for errors:
   - `read_console_messages` with pattern:
     `"error|Error|warn|Warning|Uncaught|rejected|fail|500|4\\d{2}"`
   - `read_network_requests` for failed API calls (4xx, 5xx)
   - Filter out dev noise: React strict mode double-renders,
     HMR messages, Vite internal logs
   - Log any genuine errors against the current story

4. **Authenticate** if needed:
   - Read the page to check if you're on a login screen
   - This app uses email OTP, not password login. First
     ensure the test user exists:
     ```bash
     bun apps/api/scripts/seed-test-user.ts
     ```
   - Enter `test@stella.dev` in the email field and submit
   - In dev mode, the OTP is logged to the API server
     console. Read the API process output to find the line:
     `[DEV] OTP for test@stella.dev: {code} (type: ...)`
   - Enter the OTP code in the browser to complete login
   - Verify you land on the dashboard

5. **Navigate to the feature area** described in `$ARGUMENTS`:
   - Read the sidebar/navigation to find the relevant section
   - Click into it

### Phase 2: Generate User Stories

Before clicking around, generate 4-8 concrete user stories for
the feature area. These should cover:

- **Happy path**: the most common, expected flow
- **Empty state**: what happens with no data yet
- **Creation flow**: adding a new item
- **Edit flow**: modifying an existing item
- **Error case**: invalid input, missing required fields
- **Edge case**: boundary values, long text, special characters
- **Batch/bulk**: multi-select, bulk actions (if applicable)
- **Navigation**: back button, breadcrumbs, deep links

Present the stories to the user and ask if they want to adjust
the list or add specific scenarios before proceeding.

### Phase 3: Execute Stories

For each user story:

1. **Announce** which story you're starting (print to output)

2. **Record baseline** — call `read_console_messages` and
   `read_network_requests`; note the timestamp (or count)
   of the most recent entry in each. When checking for
   errors after actions, only count messages and requests
   newer than these baselines to avoid re-reporting
   findings from earlier stories.

3. **Walk through the story step by step**:
   - Use `read_page` before each action to understand the
     current UI state
   - Use `find` to locate interactive elements
   - Use `computer` (click/type) or `form_input` for
     interactions
   - After each action, pause briefly and `read_page` again
     to verify the result
   - Monitoring is always active (Phase 1, step 3)

4. **Log the result** for this story:
   - Status: pass / fail / partial
   - Console errors (if any), with timestamps
   - Network failures (if any)
   - UX observations (see Phase 4 rubric)

### Phase 4: UX Assessment Rubric

While executing each story, evaluate against these criteria.
Don't just check for crashes; assess the *experience*:

**Responsiveness**
- Do actions feel instant (<100ms visual feedback)?
- Are there loading spinners, or does the UI freeze?
- Do optimistic updates work, or does the user wait for the
  server?

**Clarity**
- Is it obvious what to do next at each step?
- Are form labels clear? Are required fields marked?
- Do error messages explain what went wrong and how to fix it?
- Are empty states helpful (not just blank)?

**Consistency**
- Do similar actions behave the same way across the feature?
- Do buttons, inputs, and layouts match the rest of the app?
- Are status badges/colors consistent with other features?

**Data integrity**
- Does created data appear immediately in lists?
- Do edits persist after page refresh?
- Does deletion actually remove the item?
- Are numbers (amounts, durations) formatted correctly?

**Edge cases**
- What happens with very long text in inputs?
- What happens if you submit an empty form?
- What happens if you double-click a submit button?
- What happens if you navigate away mid-form?

**Accessibility basics**
- Can you tab through form fields in logical order?
- Do dialogs trap focus?
- Are there visible focus indicators?

### Phase 5: Report

After all stories are executed, produce a structured report:

```markdown
## Click-Around Report: {feature}

**Date:** {date}
**Environment:** localhost:3000 (dev)
**Stories tested:** {n}/{total}

### Summary
{2-3 sentence overall assessment}

### Results

| # | Story | Status | Issues |
|---|-------|--------|--------|
| 1 | ...   | pass   | —      |
| 2 | ...   | fail   | Console error: ... |
| 3 | ...   | partial | UX: no loading state |

### Console Errors
{List all unique console errors with the story that triggered
them. Group duplicates.}

### Network Failures
{List all failed API calls: method, URL, status, response body
if available.}

### UX Issues (by severity)

**Blockers** (prevents completing the task):
- ...

**Bugs** (wrong behavior, but workaround exists):
- ...

**Paper cuts** (annoying but functional):
- ...

**Suggestions** (not broken, but could be better):
- ...

### Recommended Next Steps
{Prioritized list of fixes/improvements, ordered by impact.
Reference specific files and components where possible.}
```

Save this report to `.agents/reports/click-around-{feature-slug}-{date}.md`
where `{feature-slug}` is the feature name lowercased with spaces
replaced by hyphens (e.g., `time-tracking`, `document-upload`),
and `{date}` is `YYYY-MM-DD` (e.g., `2026-03-15`).

### Important Guidelines

- **Don't get stuck.** If a step fails after 2 attempts, log
  it as a failure and move to the next story. Don't retry
  endlessly.
- **Be realistic.** Interact like a real user would: don't
  use perfect timing, try clicking things that look clickable,
  notice if labels are confusing.
- **Watch for regressions.** If you've tested this feature
  before (check `.agents/reports/`), compare against the
  previous report and note improvements or regressions.
- **Don't fix bugs during the test.** The goal is to observe
  and report, not to fix. Fixing changes the state and
  invalidates subsequent tests.
- **Console noise.** Some warnings are expected in dev mode
  (React strict mode double-renders, HMR messages). Filter
  these out; only report genuine errors.
