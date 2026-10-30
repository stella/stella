import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { listSkillMetadata, readSkillDisplayName } from "@stll/skills";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { createTranslator, IntlProvider } = await import("use-intl");
const { BUILT_IN_SKILL_COPY, useSkillLabel, useSkillsPages } =
  await import("@/lib/knowledge/built-in-skills");
const { skillsOptions } = await import("@/lib/knowledge/queries");
const { toSafeId } = await import("@/lib/safe-id");
const englishMessages = (await import("@/i18n/langs/en.json")).default;
const czechMessages = (await import("@/i18n/langs/cs.json")).default;

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const LOCALES = {
  cs: czechMessages,
  en: englishMessages,
} as const;
type Locale = keyof typeof LOCALES;

const builtInRow = {
  id: "playbook-builder",
  scope: "built-in",
  origin: "built-in",
  slug: "playbook-builder",
  name: "Build a playbook",
  description: "Text written for the model.",
  version: null,
  license: null,
  compatibility: null,
  enabled: true,
  invocation: "auto",
  resourceCount: 0,
} as const;

const installedRow = {
  lastEdit: null,
  id: toSafeId<"agentSkill">("skill-1"),
  scope: "team",
  origin: "authored",
  slug: "review",
  name: "Team review",
  description: "Review a contract against team rules.",
  version: null,
  license: null,
  compatibility: null,
  sourceUrl: null,
  contentHash: "hash",
  enabled: true,
  invocation: "auto",
  boundClientId: null,
  boundWorkspaceId: null,
  command: null,
  body: null,
  userId: USER_ID,
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

const seededClient = () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(skillsOptions(ORGANIZATION_ID, USER_ID).queryKey, {
    pageParams: [""],
    pages: [
      {
        builtIn: [builtInRow],
        canManageTeam: false,
        installed: [installedRow],
        limit: 50,
        nextCursor: null,
      },
    ],
  });
  return queryClient;
};

const renderInLocale = <Result,>(useHook: () => Result, initial: Locale) => {
  const queryClient = seededClient();
  const locale = { current: initial };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <IntlProvider
        locale={locale.current}
        messages={LOCALES[locale.current]}
        timeZone="UTC"
      >
        {children}
      </IntlProvider>
    </QueryClientProvider>
  );
  const rendered = renderHook(useHook, { wrapper });
  return {
    ...rendered,
    switchTo: (next: Locale) => {
      locale.current = next;
      rendered.rerender();
    },
  };
};

describe("built-in skill copy", () => {
  test("each built-in's English title is the title its SKILL.md gives", () => {
    const t = createTranslator({ locale: "en", messages: englishMessages });
    for (const skill of listSkillMetadata()) {
      const copy = Object.entries(BUILT_IN_SKILL_COPY).find(
        ([id]) => id === skill.name,
      );
      expect(copy).toBeDefined();
      expect(copy === undefined ? undefined : t(copy[1].name)).toBe(
        readSkillDisplayName(skill),
      );
    }
  });
});

describe("useSkillsPages", () => {
  test("titles built-in rows in the reader's language and follows a switch", async () => {
    const { result, switchTo } = renderInLocale(
      () =>
        useSkillsPages({ organizationId: ORGANIZATION_ID, userId: USER_ID })
          .data,
      "cs",
    );
    const czech = LOCALES.cs.knowledge.agentSkills.builtIn.playbookBuilder;
    const english = LOCALES.en.knowledge.agentSkills.builtIn.playbookBuilder;

    await waitFor(() => {
      expect(result.current?.pages.at(0)?.builtIn.at(0)).toMatchObject({
        description: czech.description,
        name: czech.name,
        slug: "playbook-builder",
      });
    });
    expect(result.current?.pages.at(0)?.installed).toEqual([installedRow]);

    await act(async () => {
      switchTo("en");
    });
    expect(result.current?.pages.at(0)?.builtIn.at(0)).toMatchObject({
      description: english.description,
      name: english.name,
    });
  });
});

describe("useSkillLabel", () => {
  test("titles a built-in in the reader's language, over a stored title", async () => {
    const { result, switchTo } = renderInLocale(
      () =>
        useSkillLabel()({
          skillDisplayName: "Build a playbook",
          skillName: "playbook-builder",
        }),
      "cs",
    );
    expect(result.current).toBe(
      LOCALES.cs.knowledge.agentSkills.builtIn.playbookBuilder.name,
    );

    await act(async () => {
      switchTo("en");
    });
    expect(result.current).toBe("Build a playbook");
  });

  test("an installed skill keeps its stored title, even on a built-in's slug", () => {
    const { result } = renderInLocale(() => {
      const skillLabel = useSkillLabel();
      return [
        skillLabel({
          skillDisplayName: "Our playbooks",
          skillId: "skill-3",
          skillName: "playbook-builder",
        }),
        skillLabel({ skillId: "skill-4", skillName: "nda" }),
      ];
    }, "cs");
    expect(result.current).toEqual(["Our playbooks", "nda"]);
  });
});
