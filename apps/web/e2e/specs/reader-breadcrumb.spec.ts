import * as v from "valibot";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { createCaseDecisionViewTab } from "../../src/components/inspector/case-decision-view";
import {
  inspectorMinimizedStorageKey,
  inspectorStateStorageKey,
} from "../../src/components/inspector/inspector-storage-keys";
import type { GenericTab } from "../../src/components/inspector/inspector-store-types";
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
const titles = headings.map(({ title }) => title);
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
const views = [
  {
    kind: "decision",
    value: decision,
    tab: createCaseDecisionViewTab({ ...decision, decisionId: decision.id }),
    mainPath: DOCKED_CHAT_LEGAL_ROUTES.decision.path,
    paths: [
      `/v1/case/decisions/${decision.id}`,
      `/v1/case/decisions/by-slug/${decision.slug}`,
    ],
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
    await page.setViewportSize({ width: 1440, height: 900 });
    await installDockedLegalFixtures(page);
    await page.route(
      (url) =>
        url.origin === E2E_API_ORIGIN && view.paths.includes(url.pathname),
      (route) => route.fulfill({ json: view.value }),
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
    } satisfies GenericTab;
    await page.addInitScript(
      ({ restoredTab, stateKey, minimizedKey }) => {
        localStorage.setItem(
          stateKey,
          JSON.stringify({
            tabs: [restoredTab],
            groups: [],
            groupAssignments: {},
            activeId: restoredTab.id,
            collapsedGroupIds: [],
          }),
        );
        localStorage.setItem(minimizedKey, "0");
      },
      {
        restoredTab: tab,
        stateKey: inspectorStateStorageKey(scope),
        minimizedKey: inspectorMinimizedStorageKey(scope),
      },
    );
    await page.goto("/chat");
    const inspector = page.locator('[data-slot="inspector-dock-pane"]');
    await expect(inspector.locator('[data-anchor="heading-4"]')).toBeAttached();
    for (const surface of ["inspector", "main"] as const) {
      const root = surface === "inspector" ? inspector : page.locator("body");
      const breadcrumb = root.locator('[data-slot="reader-breadcrumb"]');
      await expect(breadcrumb).toHaveCount(1);
      const initialContents = breadcrumb.getByRole("button", {
        name: "Contents",
        exact: true,
      });
      await expect(initialContents).toBeVisible();
      await initialContents.click();
      await expect(
        page.getByRole("button", { name: titles[0], exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      const before = await breadcrumb.boundingBox();
      expect(before).not.toBeNull();
      await root.locator('[data-anchor="heading-4"]').evaluate((heading) => {
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
        viewport.scrollTop +=
          heading.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          64;
      });
      const current = breadcrumb.getByRole("button", {
        name: `Contents: ${titles.at(-1)}`,
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
          '[data-contents-anchor="heading-4"][aria-current="location"]',
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
        await handle.press("Home");
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
        await expect(inspector).not.toBeVisible();
      }
    }
  });
}
