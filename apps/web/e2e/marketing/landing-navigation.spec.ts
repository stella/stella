import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Class guard: landing islands must survive ClientRouter (view transition)
// navigation round-trips. Astro swaps the whole document on soft navigation,
// which re-runs island hydration, IntersectionObserver-gated loops, and the
// head swap that carries the stylesheets the islands' layout depends on. A
// regression anywhere in that path shows up as the opening product scene
// failing to re-reach the same healthy interactive state it had on the
// initial load, so the spec asserts that state twice: fresh load, and again
// after navigating to a product page and going back.

const SOFT_NAV_MARKER = "__landingSoftNavProbe";

type OpeningSceneHealth = {
  present: boolean;
  // The Teams window sits inset inside the scene (start/top offsets applied),
  // not collapsed onto the scene origin.
  teamsInsideScene: boolean;
  // The Teams window occupies its designed fraction of the scene, not an
  // unconstrained auto width.
  teamsProportional: boolean;
  // The auto-playing Teams loop reaches the answer step: the agent answer
  // message fades in (its reveal is opacity-driven, so visibility checks
  // alone cannot see it).
  deviationCardShown: boolean;
};

const HEALTHY: OpeningSceneHealth = {
  present: true,
  teamsInsideScene: true,
  teamsProportional: true,
  deviationCardShown: true,
};

const readOpeningSceneHealth = (): OpeningSceneHealth => {
  // The companions are staged in by root scroll distance (hidden at zero
  // scroll by design), so the healthy state is only reachable past the
  // reveal range (ends by 480px). Scrolling inside the polled read makes the
  // check self-correcting against the router's scroll restoration; "instant"
  // opts out of the page's smooth scrolling. A poll iteration that runs in
  // the same frame as the scroll may still see the pre-scroll reveal state;
  // the next iteration reads the settled one.
  window.scrollTo({ top: 600, behavior: "instant" });
  const scene = document.querySelector("#opening-product-story .cli-story");
  const teams = document.querySelector("#opening-product-story .cli-client");
  // The answer is the second chat step in the Teams card (prompt, answer).
  const card = teams?.querySelectorAll(".story-step").item(1) ?? null;
  if (!scene || !teams || !card) {
    return {
      present: false,
      teamsInsideScene: false,
      teamsProportional: false,
      deviationCardShown: false,
    };
  }
  const sceneRect = scene.getBoundingClientRect();
  const teamsRect = teams.getBoundingClientRect();
  return {
    present: true,
    teamsInsideScene:
      teamsRect.left > sceneRect.left + 1 && teamsRect.top > sceneRect.top + 1,
    teamsProportional:
      teamsRect.width > 0 && teamsRect.width < sceneRect.width * 0.35,
    deviationCardShown: getComputedStyle(card).opacity === "1",
  };
};

const expectHealthyOpeningScene = async (page: Page) => {
  const story = page.locator("#opening-product-story");
  await expect(story.locator(".cli-story")).toBeVisible();
  await expect(story.locator(".cli-main-window")).toBeVisible();
  await expect(story.locator(".cli-client")).toBeVisible();
  await expect(story.locator(".cli-response")).toBeVisible();
  await expect(story.locator(".cli-window")).toBeVisible();

  await expect
    .poll(() => page.evaluate(readOpeningSceneHealth), {
      message: "opening scene reaches its healthy interactive state",
      timeout: 20_000,
    })
    .toEqual(HEALTHY);
};

// Class guard: companion card content must fit its card box. Card text uses
// clamp() with absolute rem floors (a readability decision), while the card
// boxes scale with the scene; CliMcpPreview reconciles the two with rem
// floors/caps on the boxes (and a content-driven Teams height). Any future
// resize or copy change that lets content outgrow its box again, or shrinks
// body text below its readability floor, fails here at both a notebook-class
// and a desktop-class viewport.

const CARD_FIT_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1680, height: 1050 },
] as const;

type CardFitCheck = {
  name: string;
  selector: string;
  // Body-text elements and their readability floor in px. The floors mirror
  // the clamp() rem minimums in CliMcpPreview at the 16px root: Teams body
  // text clamp(.45rem, …) → 7.2px, terminal result text clamp(.4rem, …) →
  // 6.4px (minus a rounding epsilon). The editor card is a recording; it has
  // no body text to measure.
  text: { selector: string; minFontPx: number } | null;
};

const CARD_FIT_CHECKS: readonly CardFitCheck[] = [
  {
    name: "teams",
    selector: ".cli-client",
    text: { selector: ".story-step p", minFontPx: 7.15 },
  },
  { name: "editor", selector: ".cli-response", text: null },
  {
    name: "terminal",
    selector: ".cli-window",
    text: { selector: ".cli-result p", minFontPx: 6.35 },
  },
];

// Runs in the page. Returns a list of human-readable violations; healthy is
// the empty list.
const readCompanionCardFit = (checks: readonly CardFitCheck[]): string[] => {
  const TOLERANCE_PX = 2;
  const issues: string[] = [];
  const describeElement = (element: Element) => {
    const classes = [...element.classList].slice(0, 3).join(".");
    return classes
      ? `${element.tagName.toLowerCase()}.${classes}`
      : element.tagName.toLowerCase();
  };
  const scene = document.querySelector("#opening-product-story .cli-story");
  if (!scene) {
    return ["opening scene not found"];
  }
  for (const check of checks) {
    const card = scene.querySelector(check.selector);
    if (!(card instanceof HTMLElement)) {
      issues.push(`${check.name}: card not found`);
      continue;
    }
    const cardRect = card.getBoundingClientRect();
    if (cardRect.width === 0 || cardRect.height === 0) {
      issues.push(`${check.name}: card has no box`);
      continue;
    }
    for (const element of [card, ...card.querySelectorAll("*")]) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      const style = getComputedStyle(element);
      if (style.display === "none") {
        continue;
      }
      // No vertical overflow inside any clipping box. Line-clamped text
      // hides trailing lines by design and is exempt; single-line truncate
      // only clips horizontally, which this check does not look at.
      const clipsVertically = ["auto", "clip", "hidden", "scroll"].includes(
        style.overflowY,
      );
      const isLineClamped =
        style.webkitLineClamp !== "" && style.webkitLineClamp !== "none";
      if (
        clipsVertically &&
        !isLineClamped &&
        element.scrollHeight > element.clientHeight + TOLERANCE_PX
      ) {
        issues.push(
          `${check.name}: ${describeElement(element)} overflows vertically ` +
            `(scrollHeight ${element.scrollHeight} > clientHeight ${element.clientHeight})`,
        );
      }
      // Every rendered box stays inside the card box: content escaping the
      // card is exactly what the card's overflow clip cuts mid-glyph.
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        continue;
      }
      if (
        rect.top < cardRect.top - TOLERANCE_PX ||
        rect.bottom > cardRect.bottom + TOLERANCE_PX ||
        rect.left < cardRect.left - TOLERANCE_PX ||
        rect.right > cardRect.right + TOLERANCE_PX
      ) {
        issues.push(
          `${check.name}: ${describeElement(element)} escapes the card box ` +
            `(element ${Math.round(rect.top)}..${Math.round(rect.bottom)} vs ` +
            `card ${Math.round(cardRect.top)}..${Math.round(cardRect.bottom)})`,
        );
      }
    }
    if (check.text) {
      for (const text of card.querySelectorAll(check.text.selector)) {
        const fontSize = Number.parseFloat(getComputedStyle(text).fontSize);
        if (fontSize < check.text.minFontPx) {
          issues.push(
            `${check.name}: ${describeElement(text)} font-size ${fontSize}px ` +
              `is below the ${check.text.minFontPx}px readability floor`,
          );
        }
      }
    }
  }
  return issues;
};

for (const viewport of CARD_FIT_VIEWPORTS) {
  test(`companion cards fit their boxes at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    // Layout is what is under test; reduced motion removes the entry/typing
    // animations whose transient transforms would otherwise perturb the
    // scrollHeight/rect reads mid-animation.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "networkidle" });
    const story = page.locator("#opening-product-story");
    await expect(story.locator(".cli-client")).toBeVisible();
    // Settle the scroll-staged reveal at its resting state (the reveal
    // timelines end by 480px of root scroll). "instant" opts out of the
    // page's smooth scrolling so the poll below never races the animation.
    await page.evaluate(() =>
      window.scrollTo({ top: 600, behavior: "instant" }),
    );
    await expect
      .poll(() => page.evaluate(readCompanionCardFit, CARD_FIT_CHECKS), {
        message: "companion card content fits its card box",
        timeout: 20_000,
      })
      .toEqual([]);
  });
}

test("opening scene stays healthy after a navigation round-trip", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expectHealthyOpeningScene(page);

  // Tag the current document so the round-trip provably stays on the
  // client-side router: a full page reload would reset the flag and bypass
  // the swap path this spec guards.
  await page.evaluate((marker) => {
    Reflect.set(window, marker, true);
  }, SOFT_NAV_MARKER);

  // Navigate via the header product menu so the scene is near the viewport
  // again right after going back. The menu interaction expects the header's
  // top-of-page state, so undo the health check's reveal scroll first. The
  // menu is hover-open on fine pointers (a click on the summary would toggle
  // the hover-opened dropdown straight back shut), so hover it instead.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.locator("summary.nav-link").first().hover();
  await expect(page.locator("details.nav-dropdown").first()).toHaveAttribute(
    "open",
    "",
  );
  await page.locator('.nav-mega a[href="/product/workspace"]').first().click();
  await page.waitForURL("**/product/workspace");
  await expect(page.locator("main").first()).toBeVisible();

  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/");
  expect(
    await page.evaluate(
      (marker) => Reflect.get(window, marker) === true,
      SOFT_NAV_MARKER,
    ),
    "round-trip must stay on the client-side router (no full reload)",
  ).toBe(true);

  await expectHealthyOpeningScene(page);
});

// Recorded-scene posters must be theme-correct from the first paint: the
// server cannot know the visitor's theme, so RecordedStellaScene renders BOTH
// posters and CSS picks via the `.dark` variant. This guards the class of
// bug where a JS-selected single poster bakes the light theme into the SSR
// HTML of below-fold islands (dark visitors saw light posters in dark
// chrome until hydration). A regression to one JS-picked <img> fails the
// pair-structure assertion in both themes.
for (const theme of ["light", "dark"] as const) {
  test(`recorded-scene posters are ${theme}-correct by CSS`, async ({
    page,
  }) => {
    await page.addInitScript((initialTheme) => {
      localStorage.setItem("theme", initialTheme);
    }, theme);
    await page.goto("/product/templates", { waitUntil: "networkidle" });
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
    );
    await expect
      .poll(
        () =>
          page.evaluate((expectedTheme) => {
            const posters = [
              ...document.querySelectorAll('.product-media img[src*="story-"]'),
            ];
            if (posters.length === 0 || posters.length % 2 !== 0) {
              return `expected theme-poster pairs, found ${posters.length} posters`;
            }
            const issues: string[] = [];
            for (const poster of posters) {
              if (!(poster instanceof HTMLImageElement)) {
                continue;
              }
              const src = poster.src.split("/").pop() ?? "";
              const isDarkAsset = src.includes("-dark-poster");
              const isVisible =
                poster.offsetParent !== null &&
                getComputedStyle(poster).display !== "none";
              const shouldBeVisible =
                expectedTheme === "dark" ? isDarkAsset : !isDarkAsset;
              if (isVisible !== shouldBeVisible) {
                issues.push(
                  `${src}: visible=${isVisible} in ${expectedTheme} theme`,
                );
              }
            }
            return issues.length === 0 ? "ok" : issues.join("; ");
          }, theme),
        { message: "every visible scene poster matches the theme" },
      )
      .toBe("ok");
  });
}
