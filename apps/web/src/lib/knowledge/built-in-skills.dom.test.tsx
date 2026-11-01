import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { AbstractIntlMessages } from "use-intl";

import { listSkillMetadata, readSkillDisplayName } from "@stll/skills";
import { STARTER_SKILLS } from "@stll/skills/starter-skills";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { createTranslator, IntlProvider } = await import("use-intl");
const {
  BUILT_IN_SKILL_COPY,
  localizeStarterSkill,
  STARTER_SKILL_COPY,
  useSkillLabel,
  useSkillsPages,
} = await import("@/lib/knowledge/built-in-skills");
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

const summarizeSeed = STARTER_SKILLS[0];

const starterRow = {
  ...installedRow,
  id: toSafeId<"agentSkill">("skill-2"),
  scope: "private",
  origin: "default",
  slug: summarizeSeed.slug,
  name: summarizeSeed.name,
  description: summarizeSeed.description,
  command: summarizeSeed.command,
  body: summarizeSeed.body,
} as const;

const authoredStarterRow = { ...starterRow, origin: "authored" } as const;

type InstalledRow =
  typeof authoredStarterRow | typeof installedRow | typeof starterRow;

const seededClient = (installed: InstalledRow[] = [installedRow]) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(skillsOptions(ORGANIZATION_ID, USER_ID).queryKey, {
    pageParams: [""],
    pages: [
      {
        builtIn: [builtInRow],
        canManageTeam: false,
        installed,
        limit: 50,
        nextCursor: null,
      },
    ],
  });
  return queryClient;
};

const renderInLocale = <Result,>(
  useHook: () => Result,
  initial: Locale,
  installed?: InstalledRow[],
) => {
  const queryClient = seededClient(installed);
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

type LocalizedCopy = {
  body: string | null;
  description: string;
  name: string;
};

describe("starter skill copy", () => {
  // Abstract catalogues: typing every key of both files is compiler work these
  // lookups do not need.
  const englishCatalogue: AbstractIntlMessages = englishMessages;
  const czechCatalogue: AbstractIntlMessages = czechMessages;
  const english = createTranslator({
    locale: "en",
    messages: englishCatalogue,
  });
  const czech = createTranslator({ locale: "cs", messages: czechCatalogue });

  test("covers exactly the seeded skills, in the seeded English", () => {
    expect(Object.keys(STARTER_SKILL_COPY).toSorted()).toEqual(
      STARTER_SKILLS.map(({ slug }) => slug).toSorted(),
    );
    for (const seed of STARTER_SKILLS) {
      const copy = STARTER_SKILL_COPY[seed.slug];
      expect({
        body: english(copy.body),
        description: english(copy.description),
        name: english(copy.name),
      }).toEqual({
        body: seed.body,
        description: seed.description,
        name: seed.name,
      });
    }
  });

  test("an untouched starter reads entirely in the reader's language", () => {
    for (const seed of STARTER_SKILLS) {
      const copy = STARTER_SKILL_COPY[seed.slug];
      const localized: LocalizedCopy = localizeStarterSkill(seed, (key) =>
        czech(key),
      );
      expect(localized).toEqual({
        ...seed,
        body: czech(copy.body),
        description: czech(copy.description),
        name: czech(copy.name),
      });
      expect(localized.name).not.toBe(seed.name);
      expect(localized.description).not.toBe(seed.description);
      expect(localized.body).not.toBe(seed.body);
    }
  });

  test("each field a member edited stays theirs, the others still translate", () => {
    const copy = STARTER_SKILL_COPY[summarizeSeed.slug];
    const translated = {
      body: czech(copy.body),
      description: czech(copy.description),
      name: czech(copy.name),
    };
    const typed = "Typed by a member";
    const localize = (
      edit: { body: string } | { description: string } | { name: string },
    ) =>
      localizeStarterSkill({ ...summarizeSeed, ...edit }, (key) => czech(key));

    expect(localize({ body: typed })).toMatchObject({
      ...translated,
      body: typed,
    });
    expect(localize({ description: typed })).toMatchObject({
      ...translated,
      description: typed,
    });
    expect(localize({ name: typed })).toMatchObject({
      ...translated,
      name: typed,
    });
  });

  test("a renamed starter, which has a new slug, shows what is stored", () => {
    const row = { ...summarizeSeed, slug: "our-summary-a1b2", name: "Ours" };
    expect(localizeStarterSkill(row, (key) => czech(key))).toEqual(row);
  });

  test("a body the list left out stays left out", () => {
    const localized: LocalizedCopy = localizeStarterSkill(
      { ...summarizeSeed, body: null },
      (key) => czech(key),
    );
    expect(localized.body).toBeNull();
    expect(localized.name).toBe(
      czech(STARTER_SKILL_COPY[summarizeSeed.slug].name),
    );
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

  test("shows an untouched starter in the reader's language and follows a switch", async () => {
    const { result, switchTo } = renderInLocale(
      () =>
        useSkillsPages({
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
        }).data?.pages.at(0)?.installed,
      "cs",
      [starterRow],
    );
    const czech = LOCALES.cs.knowledge.agentSkills.starter.summarize;

    await waitFor(() => {
      expect(result.current?.at(0)).toMatchObject(czech);
    });

    await act(async () => {
      switchTo("en");
    });
    expect(result.current?.at(0)).toMatchObject({
      body: summarizeSeed.body,
      description: summarizeSeed.description,
      name: summarizeSeed.name,
    });
  });

  test("leaves a skill a member wrote word for word as they stored it", async () => {
    const { result } = renderInLocale(
      () =>
        useSkillsPages({
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
        }).data?.pages.at(0)?.installed,
      "cs",
      [authoredStarterRow],
    );

    await waitFor(() => {
      expect(result.current).toEqual([authoredStarterRow]);
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

  test("titles an unrenamed starter in the reader's language", async () => {
    const { result, switchTo } = renderInLocale(() => {
      const skillLabel = useSkillLabel();
      return [
        skillLabel({
          skillDisplayName: summarizeSeed.name,
          skillId: "skill-2",
          skillName: summarizeSeed.slug,
        }),
        skillLabel({
          skillDisplayName: "My summary",
          skillId: "skill-2",
          skillName: summarizeSeed.slug,
        }),
      ];
    }, "cs");
    expect(result.current).toEqual([
      LOCALES.cs.knowledge.agentSkills.starter.summarize.name,
      "My summary",
    ]);

    await act(async () => {
      switchTo("en");
    });
    expect(result.current).toEqual([summarizeSeed.name, "My summary"]);
  });
});
