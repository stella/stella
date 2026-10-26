import * as v from "valibot";

import {
  INSPECTOR_STORAGE,
  inspectorStorageBaseKey,
  ownerStorageKey,
} from "@stll/api-contract/browser-storage";
import { createCaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";
import type { OrganizationAIAvailability } from "@stll/api-contract/organization-ai-availability";
import { decisionTitle } from "@stll/decision-reader/decision-title";
import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { INSPECTOR_PANE_MIN_WIDTH } from "@stll/ui/inspector";

import { READER_BREADCRUMB_CLEARANCE } from "../../src/components/legal-reader/reader-breadcrumb-scroll";
import { createStatuteViewTab } from "../../src/features/statutes/statute-inspector.logic";
import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import { E2E_API_ORIGIN } from "../helpers/api";
import {
  DOCKED_CHAT_LEGAL_ROUTES,
  installDockedLegalFixtures,
} from "../helpers/docked-chat-legal-fixtures";
import { dockedChatLegalPayloads } from "../helpers/docked-chat-legal-payloads";
import { expect, test } from "../helpers/test";

const headings = [
  { title: "Část druhá", level: 1 },
  { title: "Hlava I", level: 2 },
  { title: "Oddíl A", level: 3 },
  { title: "Díl 1", level: 4 },
  { title: "§ 5 Žádost o poskytnutí přímé platby", level: 5 },
] as const;
const ast = {
  version: 1,
  source: {
    system: "synthetic",
    documentId: "breadcrumb",
    webUrl: "",
    printUrl: "",
  },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "introduction",
      anchorId: "introduction",
      type: "paragraph",
      inlines: [
        { type: "text", text: "Úvodní ustanovení před nadpisy. ".repeat(40) },
      ],
      plainText: "Úvodní ustanovení před nadpisy. ".repeat(40),
    },
    ...headings.flatMap(({ title, level }, index) => [
      {
        id: `heading-${index}`,
        anchorId: `heading-${index}`,
        type: "heading" as const,
        level,
        inlines: [{ type: "text" as const, text: title }],
        plainText: title,
      },
      {
        id: `text-${index}`,
        anchorId: `text-${index}`,
        type: "paragraph" as const,
        inlines: [
          {
            type: "text" as const,
            text: "Soud posoudil podmínky žádosti a předložené listiny. ".repeat(
              30,
            ),
          },
        ],
        plainText:
          "Soud posoudil podmínky žádosti a předložené listiny. ".repeat(30),
      },
    ]),
  ],
} satisfies DocumentAst;
const decision = { ...dockedChatLegalPayloads.decision, documentAst: ast };
const statute = { ...dockedChatLegalPayloads.statute, documentAst: ast };
const paragraphOnlyAst = {
  ...ast,
  blocks: [
    {
      id: "introduction",
      anchorId: "introduction",
      type: "paragraph" as const,
      inlines: [
        { type: "text" as const, text: "Úvodní ustanovení. ".repeat(40) },
      ],
      plainText: "Úvodní ustanovení. ".repeat(40),
    },
    ...headings.map(({ title }, index) => ({
      id: `paragraph-${index}`,
      anchorId: `paragraph-${index}`,
      type: "paragraph" as const,
      inlines: [
        {
          type: "text" as const,
          text: `${title}. Soud posoudil podmínky žádosti a předložené listiny. `.repeat(
            30,
          ),
        },
      ],
      plainText:
        `${title}. Soud posoudil podmínky žádosti a předložené listiny. `.repeat(
          30,
        ),
    })),
  ],
} satisfies DocumentAst;
const paragraphOnlyDecision = {
  ...dockedChatLegalPayloads.decision,
  documentAst: paragraphOnlyAst,
};
const paragraphAnalysisHeadingAt = (
  index: number,
): DecisionAnalysis["tree"][number] => {
  const heading = headings.at(index);
  if (heading === undefined) {
    throw new Error(`Missing analysis heading at index ${index}`);
  }
  return {
    id: `analysis-${index}`,
    label: heading.title,
    category: index === headings.length - 1 ? "holding" : "reasoning",
    startAnchorId: `paragraph-${index}`,
    endAnchorId: "paragraph-4",
    annotations: [],
    children:
      index + 1 < headings.length
        ? [paragraphAnalysisHeadingAt(index + 1)]
        : [],
  };
};
const paragraphOnlyAnalysis = {
  version: 2,
  generatedAt: "2026-10-06T08:00:00.000Z",
  model: "synthetic",
  inputFingerprint: "f".repeat(64),
  tree: [paragraphAnalysisHeadingAt(0)],
} satisfies DecisionAnalysis;
const decisionTab = {
  type: "case-law-decision",
  id: `case-law-decision:${decision.id}`,
  label: decisionTitle(decision),
  payload: {
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    route: createCaseLawDecisionRouteParams({
      ...decision,
      decisionId: decision.id,
    }),
  },
};
const views = [
  {
    kind: "decision",
    value: decision,
    // The inspector's tab factory module reaches the router types, which the
    // e2e program cannot load; the restore assertions below catch a drift.
    tab: decisionTab,
    mainPath: DOCKED_CHAT_LEGAL_ROUTES.decision.path,
    paths: [
      `/v1/case/decisions/${decision.id}`,
      `/v1/case/decisions/by-slug/${decision.slug}`,
    ],
    anchors: {
      introduction: "introduction",
      first: "heading-0",
      active: "heading-4",
    },
    analysis: null,
  },
  {
    kind: "statute",
    value: statute,
    tab: createStatuteViewTab({
      ...statute,
      documentId: statute.id,
      statuteTitle: statute.title,
    }),
    mainPath: DOCKED_CHAT_LEGAL_ROUTES.statute.path,
    paths: [
      `/v1/law/statutes/${statute.id}`,
      `/v1/law/statutes/by-slug/${statute.slug}`,
    ],
    anchors: {
      introduction: "introduction",
      first: "heading-0",
      active: "heading-4",
    },
    analysis: null,
  },
  {
    kind: "paragraph-only decision",
    value: paragraphOnlyDecision,
    tab: decisionTab,
    mainPath: DOCKED_CHAT_LEGAL_ROUTES.decision.path,
    paths: [
      `/v1/case/decisions/${paragraphOnlyDecision.id}`,
      `/v1/case/decisions/by-slug/${paragraphOnlyDecision.slug}`,
    ],
    anchors: {
      introduction: "introduction",
      first: "paragraph-0",
      active: "paragraph-4",
    },
    analysis: paragraphOnlyAnalysis,
  },
];
const sessionSchema = v.object({
  user: v.object({ id: v.string() }),
  session: v.object({ activeOrganizationId: v.string() }),
});

for (const view of views) {
  test(`the ${view.kind} breadcrumb shares one pinned controls row in inspector and main reader`, async ({
    page,
    request,
  }) => {
    if (view.analysis !== null) {
      expect(new Set(paragraphOnlyAst.blocks.map(({ type }) => type))).toEqual(
        new Set(["paragraph"]),
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await installDockedLegalFixtures(page);
    await page.route(
      (url) =>
        url.origin === E2E_API_ORIGIN &&
        (view.paths.includes(url.pathname) ||
          (view.analysis !== null &&
            (url.pathname ===
              `/v1/case/decisions/${paragraphOnlyDecision.id}/analysis` ||
              url.pathname === "/v1/organization-settings/ai-availability"))),
      async (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname.endsWith("/analysis") && view.analysis !== null) {
          await route.fulfill({
            json: {
              status: "done",
              analysis: view.analysis,
            } satisfies { status: "done"; analysis: DecisionAnalysis },
          });
          return;
        }
        if (pathname === "/v1/organization-settings/ai-availability") {
          const availability = {
            available: true,
            instanceProvisioned: true,
            orgConfigured: false,
            unavailableReason: null,
            providerConfiguration: "allowed",
            deferredServiceTierAvailable: false,
            mockAnswers: false,
          } satisfies OrganizationAIAvailability;
          await route.fulfill({ json: availability });
          return;
        }
        await route.fulfill({ json: view.value });
      },
    );
    const response = await request.get(
      `${E2E_API_ORIGIN}/api/auth/get-session`,
    );
    expect(response.ok()).toBe(true);
    const session = v.parse(sessionSchema, await response.json());
    const scope = {
      userId: session.user.id,
      organizationId: session.session.activeOrganizationId,
    };
    const tab = {
      type: "view",
      viewType: view.tab.type,
      id: view.tab.id,
      label: view.tab.label,
      payload: view.tab.payload,
    };
    await page.addInitScript(
      ({
        restoredTab,
        stateKey,
        minimizedKey,
        stateVersion,
        minimizedVersion,
      }) => {
        localStorage.setItem(
          stateKey,
          JSON.stringify({
            version: stateVersion,
            value: {
              tabs: [restoredTab],
              groups: [],
              groupAssignments: {},
              activeId: restoredTab.id,
              collapsedGroupIds: [],
            },
          }),
        );
        localStorage.setItem(
          minimizedKey,
          JSON.stringify({ version: minimizedVersion, value: false }),
        );
      },
      {
        restoredTab: tab,
        stateKey: ownerStorageKey(
          inspectorStorageBaseKey(
            INSPECTOR_STORAGE.state,
            scope.organizationId,
          ),
          { kind: "user", userId: scope.userId },
        ),
        minimizedKey: ownerStorageKey(
          inspectorStorageBaseKey(
            INSPECTOR_STORAGE.minimized,
            scope.organizationId,
          ),
          { kind: "user", userId: scope.userId },
        ),
        stateVersion: INSPECTOR_STORAGE.state.version,
        minimizedVersion: INSPECTOR_STORAGE.minimized.version,
      },
    );
    await page.goto("/chat", { waitUntil: "domcontentloaded" });
    const inspector = page.locator('[data-slot="inspector-dock-pane"]');
    await expect(
      inspector.locator(`[data-anchor="${view.anchors.active}"]`),
    ).toBeAttached({ timeout: 30_000 });
    for (const surface of ["inspector", "main"] as const) {
      const root = surface === "inspector" ? inspector : page.locator("body");
      if (surface === "main" && view.kind !== "statute") {
        // The authenticated workspace replaces the public loading reader.
        // Its editable composer identifies the reader that owns interactions.
        await expect(
          root.locator(
            '[data-file-viewer-root="true"] [data-slot="docked-chat-composer"] [role="textbox"][contenteditable="true"]',
          ),
        ).toBeVisible();
      }
      const breadcrumb = root.locator('[data-slot="reader-breadcrumb"]');
      await expect(breadcrumb).toHaveCount(1);
      const pinnedControls = breadcrumb.locator("..");
      for (const name of ["Zoom in", "Zoom out", "Reset zoom"]) {
        await expect(
          pinnedControls.getByRole("button", { name, exact: true }),
        ).toHaveCount(1);
      }
      // Attachment precedes layout during inspector restoration and route
      // changes. Read geometry only once the actual scroll viewport has size.
      await expect
        .poll(
          async () =>
            await root
              .locator(`[data-anchor="${view.anchors.introduction}"]`)
              .evaluate((introduction) => {
                const content =
                  introduction.closest(
                    '[data-slot="reader-document-column"]',
                  ) ?? introduction.closest("main.reader-paper");
                const first = Array.from(
                  content?.querySelectorAll("h1, h2, h3, p") ?? [],
                ).find((element) => {
                  const bounds = element.getBoundingClientRect();
                  return bounds.width > 1 && bounds.height > 1;
                });
                // Both surfaces render a breadcrumb: measure the one in this reader.
                let reader: Element | null = introduction;
                while (
                  reader?.querySelector('[data-slot="reader-breadcrumb"]') ===
                  null
                ) {
                  reader = reader.parentElement;
                }
                const controls = reader?.querySelector(
                  '[data-slot="reader-breadcrumb"]',
                )?.parentElement;
                let viewport = introduction.parentElement;
                while (
                  viewport !== null &&
                  !["auto", "scroll"].includes(
                    getComputedStyle(viewport).overflowY,
                  )
                ) {
                  viewport = viewport.parentElement;
                }
                if (
                  viewport === null ||
                  viewport.clientWidth <= 1 ||
                  viewport.clientHeight <= 1 ||
                  first === undefined ||
                  controls === null ||
                  controls === undefined
                ) {
                  return null;
                }
                return (
                  first.getBoundingClientRect().top -
                  controls.getBoundingClientRect().bottom
                );
              }),
          {
            message: `initial ${view.kind}/${surface} content clears the laid-out controls`,
          },
        )
        .toBeGreaterThanOrEqual(0);
      const initialContents = breadcrumb.getByRole("button", {
        name: "Contents",
        exact: true,
      });
      await expect(initialContents).toBeVisible();
      await initialContents.click();
      await expect(initialContents).toHaveAttribute("aria-expanded", "true");
      await expect(
        page.locator(`[data-contents-anchor="${view.anchors.first}"]`),
      ).toBeVisible();
      await page
        .locator(`[data-contents-anchor="${view.anchors.first}"]`)
        .focus();
      await page.keyboard.press("Escape");
      await expect(initialContents).toHaveAttribute("aria-expanded", "false");
      await expect(initialContents).toBeFocused();
      if (surface === "inspector") {
        await expect(
          page.locator('[data-slot="inspector-dock"]'),
        ).toHaveAttribute("data-state", "expanded");
      }
      const before = await breadcrumb.boundingBox();
      expect(before).not.toBeNull();
      await root
        .locator(`[data-anchor="${view.anchors.active}"]`)
        .evaluate((heading, clearance) => {
          let viewport = heading.parentElement;
          while (
            viewport !== null &&
            !["auto", "scroll"].includes(getComputedStyle(viewport).overflowY)
          ) {
            viewport = viewport.parentElement;
          }
          if (viewport === null) {
            throw new Error("Reader viewport not found");
          }
          // Cross the cutoff despite fractional heading geometry and scroll rounding.
          viewport.scrollTop +=
            heading.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            clearance +
            1;
        }, READER_BREADCRUMB_CLEARANCE);
      const current = breadcrumb.getByRole("button", {
        name: `Contents: ${headings[4].title}`,
      });
      await expect(current).toBeVisible();
      expect(await breadcrumb.boundingBox()).toEqual(before);
      const geometry = await current.evaluate((button) => {
        const row = button.closest(
          '[data-slot="reader-breadcrumb"]',
        )?.parentElement;
        if (row === undefined || row === null) {
          throw new Error("Controls row not found");
        }
        const bounds = row.getBoundingClientRect();
        return {
          height: bounds.height,
          position: getComputedStyle(row).position,
          centers: [...row.querySelectorAll("button")].map(
            (control) =>
              control.getBoundingClientRect().top +
              control.getBoundingClientRect().height / 2,
          ),
        };
      });
      expect(geometry.position).toBe("absolute");
      expect(geometry.height).toBe(48);
      expect(
        Math.max(...geometry.centers) - Math.min(...geometry.centers),
      ).toBeLessThanOrEqual(1);
      await current.click();
      await expect(
        page.locator(
          `[data-contents-anchor="${view.anchors.active}"][aria-current="location"]`,
        ),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await breadcrumb.evaluate((navigation) => {
        navigation.style.flex = "0 0 60px";
        navigation.style.width = "60px";
      });
      await expect(
        breadcrumb.getByRole("button", { name: "Část druhá", exact: true }),
      ).toHaveCount(0);
      await expect(
        breadcrumb.getByRole("button", { name: "Díl 1", exact: true }),
      ).toHaveCount(0);
      await expect(
        breadcrumb.getByRole("button", { name: "Show more", exact: true }),
      ).toHaveCount(0);
      await expect
        .poll(async () =>
          current.evaluate((button) => {
            const number = button.querySelector("bdi");
            const navigation = button.closest(
              '[data-slot="reader-breadcrumb"]',
            );
            if (number === null || navigation === null) {
              return false;
            }
            const bounds = navigation.getBoundingClientRect();
            const numberBounds = number.getBoundingClientRect();
            return (
              bounds.width === 60 &&
              number.textContent === "§ 5" &&
              numberBounds.left >= bounds.left &&
              numberBounds.right <= bounds.right
            );
          }),
        )
        .toBe(true);
      await breadcrumb.evaluate((navigation) => {
        navigation.style.flex = "";
        navigation.style.width = "";
      });
      if (surface === "inspector") {
        const handle = page.locator('[data-slot="inspector-resize-handle"]');
        await handle.hover();
        await handle.press("Home");
        await expect(handle).toHaveAttribute(
          "aria-valuenow",
          String(INSPECTOR_PANE_MIN_WIDTH),
        );
        // Narrower paragraphs reflow past the active-heading cutoff. Select
        // the intended section again before measuring its number.
        await breadcrumb
          .getByRole("button", { name: `${messages.statutes.outline}:` })
          .click();
        const activeDestination = page.locator(
          `[data-contents-anchor="${view.anchors.active}"]`,
        );
        await expect(activeDestination).toBeVisible();
        await activeDestination.click();
        await expect(
          root.locator(`[data-anchor="${view.anchors.active}"]`),
        ).toBeInViewport();
        await expect(current).toBeVisible();
        await expect
          .poll(async () =>
            current.evaluate((button) => {
              const number = button.querySelector("bdi");
              if (number === null) {
                return false;
              }
              const numberRect = number.getBoundingClientRect();
              const bounds = button
                .closest('[data-slot="reader-breadcrumb"]')
                ?.getBoundingClientRect();
              return (
                bounds !== undefined &&
                numberRect.left >= bounds.left &&
                numberRect.right <= bounds.right
              );
            }),
          )
          .toBe(true);
        await inspector
          .getByRole("link", { name: messages.inspector.moveToMain })
          .click();
        await expect(page).toHaveURL(
          new RegExp(
            view.mainPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
            "u",
          ),
        );
        await expect(
          page.locator('[data-slot="inspector-dock"]'),
        ).toHaveAttribute("data-state", "collapsed");
        await expect(
          inspector.locator('[data-slot="reader-breadcrumb"]'),
        ).toHaveCount(0);
      }
    }
  });
}
