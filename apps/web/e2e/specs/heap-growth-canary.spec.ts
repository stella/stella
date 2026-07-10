import type { CDPSession, Page } from "@playwright/test";

import { expect, test } from "../helpers/test";

// Repeats a short, representative navigation cycle within a single page
// session and watches whether the JS heap settles or keeps climbing. This is
// the runtime symptom detector for the class of bug scripts/ratchet.ts's
// module-level-mutable-maps metric enumerates under "grows-per-entity": a
// module-scope Map/Set/array that a route mounts into on every visit with no
// corresponding delete. Those registries live for the tab's lifetime, not a
// component's, so a session that never restarts (a paralegal's browser tab
// left open across a workday) accumulates them without bound. A single-visit
// smoke test (route-smoke.spec.ts) can never catch this class: the leak only
// shows up on repeat.
//
// Navigation MUST stay client-side (clicking the persistent sidebar links),
// never page.goto() after the initial load: goto is a full browser
// navigation that tears down and recreates the whole JS heap, which would
// reset any module-level registry on every "visit" and make this canary
// structurally blind to the exact bug class it exists to catch.
//
// Deliberately small and cheap (no workspace/document fixtures): these four
// links are always present in the primary sidebar nav
// (apps/web/src/components/workspace-primary-nav.ts) and route to distinct,
// already-authenticated top-level pages, giving variety of mounted
// components without needing route-specific fixtures.
const CHAT_READY_SELECTOR = "main > :last-child .chat-editor .ProseMirror";

const CYCLE_ROUTES = [
  { path: "/workspaces", readySelector: "main > :last-child input" },
  {
    path: "/knowledge",
    readySelector: 'main > :last-child a[href="/knowledge/clauses"]',
  },
  { path: "/contacts", readySelector: "main > :last-child input" },
  {
    path: "/chat",
    readySelector: CHAT_READY_SELECTOR,
  },
] as const;

const NAVIGATION_CYCLES = 5;
const ROUTE_SETTLE_MS = 500;

// Heap deltas jitter run to run even right after a forced GC (V8 sweep
// timing, background compaction, JIT deopt bookkeping). Sampling 3x per
// checkpoint and taking the min collapses that jitter into one reasonably
// stable number without averaging away a real leak: a real leak grows on
// every sample, noise does not repeat in the same direction across
// independent GC passes.
const GC_SAMPLE_ATTEMPTS = 3;
const GC_SETTLE_MS = 200;

// Budget calibration: measured locally across three independent runs of this
// exact cycle against the mock-AI dev stack, post-GC delta between cycle 1
// and cycle 5 landed at 2.24-2.25 MiB every time (see PR description for the
// recorded numbers) — tightly reproducible, comfortably inside the budget
// below. 20 MiB leaves ~9x headroom over that observed noise floor for
// legitimate per-navigation churn (fresh TanStack Query cache entries,
// route-chunk module state, syntax highlighting) while still catching an
// unbounded per-navigation registry: an injected probe that pushed one batch
// of small objects per mount with no eviction blew past this budget by 9x
// within the same 5 cycles (191 MiB observed) — see the PR description.
const HEAP_GROWTH_BUDGET_BYTES = 20 * 1024 * 1024;

test("repeated navigation does not grow the JS heap unboundedly", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");

  // Sanity-checks the launch flag this spec depends on (see the
  // "heap-growth-canary" project in playwright.config.ts, which scopes
  // --js-flags=--expose-gc to this spec only). Without it every GC call
  // below silently no-ops and the measured deltas would be uncalibrated
  // allocation noise instead of a post-collection signal.
  const gcExposed = await page.evaluate(
    () =>
      typeof (globalThis as typeof globalThis & { gc?: unknown }).gc ===
      "function",
  );
  expect(
    gcExposed,
    "window.gc() is not exposed; the heap-growth-canary Playwright project must launch chromium with --js-flags=--expose-gc",
  ).toBe(true);

  // Single full navigation to enter the app; every navigation after this
  // point is a client-side sidebar link click (see the module comment above).
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page.locator(CHAT_READY_SELECTOR)).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(ROUTE_SETTLE_MS);

  const heapSnapshots: number[] = [];

  for (let cycle = 1; cycle <= NAVIGATION_CYCLES; cycle++) {
    // eslint-disable-next-line no-await-in-loop -- cycles are sequential client-side navigations against one page; each cycle's leak (if any) must accumulate on top of the last
    await runNavigationCycle(page);

    if (cycle === 1 || cycle === NAVIGATION_CYCLES) {
      // eslint-disable-next-line no-await-in-loop -- measurement must happen inline right after its cycle, not batched afterward
      heapSnapshots.push(await measureHeapUsedBytes(page, client));
    }
  }

  const [afterFirstCycle, afterLastCycle] = heapSnapshots;
  if (afterFirstCycle === undefined || afterLastCycle === undefined) {
    throw new Error(
      `expected heap snapshots after cycle 1 and cycle ${NAVIGATION_CYCLES}, got ${heapSnapshots.length}`,
    );
  }

  const deltaBytes = afterLastCycle - afterFirstCycle;
  console.log(
    `[heap-growth-canary] after cycle 1: ${formatMiB(afterFirstCycle)}, after cycle ${NAVIGATION_CYCLES}: ${formatMiB(afterLastCycle)}, delta: ${formatMiB(deltaBytes)} (budget ${formatMiB(HEAP_GROWTH_BUDGET_BYTES)})`,
  );

  expect(
    deltaBytes,
    `JS heap grew ${formatMiB(deltaBytes)} across ${NAVIGATION_CYCLES - 1} repeats of the same ${CYCLE_ROUTES.length}-route cycle (budget ${formatMiB(HEAP_GROWTH_BUDGET_BYTES)}). This usually means a module-level registry (Map/Set/array) is accumulating an entry per navigation with no eviction path — see scripts/ratchet.ts's module-level-mutable-maps "grows-per-entity" bucket for known offenders.`,
  ).toBeLessThan(HEAP_GROWTH_BUDGET_BYTES);
});

const runNavigationCycle = async (page: Page) => {
  for (const [routeIndex, route] of CYCLE_ROUTES.entries()) {
    const currentRouteRoot = page.locator("main > :last-child");
    const marker = `heap-canary-${routeIndex}`;
    // Mark the Outlet-owned root (the shell's banners/header are earlier
    // siblings). Its removal proves the previous route unmounted; URL changes
    // alone can happen before a cold route chunk or loader has mounted.
    // eslint-disable-next-line no-await-in-loop -- each marker belongs to the route being left in this sequential navigation cycle
    await currentRouteRoot.evaluate((element, value) => {
      element.dataset.heapCanaryRouteRoot = value;
    }, marker);
    // Scoped to the sidebar shell (apps/web/src/components/sidebar.tsx,
    // data-slot="sidebar") so this never accidentally matches a same-named
    // breadcrumb link rendered inside route content.
    const link = page
      .locator('[data-slot="sidebar"]')
      .locator(`a[href="${route.path}"]`);
    // Sidebar chrome can briefly render a loading skeleton across a route
    // transition (recents/pinned data refetching); an explicit visibility
    // wait survives that instead of racing click()'s shorter action timeout.
    // eslint-disable-next-line no-await-in-loop -- links within a cycle are clicked in order on the same page so any per-navigation leak accumulates
    await expect(link).toBeVisible({ timeout: 30_000 });
    // eslint-disable-next-line no-await-in-loop -- see above
    await link.click();
    // eslint-disable-next-line no-await-in-loop -- see above
    await page.waitForURL((url) => url.pathname === route.path, {
      timeout: 30_000,
    });
    // eslint-disable-next-line no-await-in-loop -- see above
    await expect(
      page.locator(`[data-heap-canary-route-root="${marker}"]`),
    ).toHaveCount(0, { timeout: 30_000 });
    // eslint-disable-next-line no-await-in-loop -- route-specific content proves the destination mounted before the next navigation can replace it
    await expect(page.locator(route.readySelector)).toBeVisible({
      timeout: 30_000,
    });
    // eslint-disable-next-line no-await-in-loop -- see above
    await page.waitForTimeout(ROUTE_SETTLE_MS);
  }
};

const measureHeapUsedBytes = async (
  page: Page,
  client: CDPSession,
): Promise<number> => {
  const samples: number[] = [];
  for (let attempt = 0; attempt < GC_SAMPLE_ATTEMPTS; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- each GC+measure attempt must settle before the next runs, otherwise back-to-back gc() calls race the same sweep
    await forceGarbageCollection(page);
    // eslint-disable-next-line no-await-in-loop -- see above
    await page.waitForTimeout(GC_SETTLE_MS);
    // eslint-disable-next-line no-await-in-loop -- see above
    const { metrics } = await client.send("Performance.getMetrics");
    const heapUsed = metrics.find(
      (metric) => metric.name === "JSHeapUsedSize",
    )?.value;
    if (heapUsed !== undefined) {
      samples.push(heapUsed);
    }
  }

  if (samples.length === 0) {
    throw new Error("Performance.getMetrics never reported JSHeapUsedSize");
  }

  return Math.min(...samples);
};

const forceGarbageCollection = async (page: Page) => {
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
  });
};

const formatMiB = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
