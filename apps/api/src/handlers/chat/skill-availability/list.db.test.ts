import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import {
  CHAT_EDIT_APPLY_MODE,
  CHAT_SKILL_CONTEXT_NEED,
  CHAT_SKILL_DOCUMENT,
  type ChatSkillContextNeed,
} from "@stll/api-contract";
import {
  listSkillMetadata,
  SKILL_REQUIRED_TOOLS_METADATA_KEY,
} from "@stll/skills";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { agentSkills } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { COUNTERPARTY_CHECK_TOOL_NAME } from "@/api/handlers/chat/tools/counterparty-check-tools";
import { GET_DOCUMENT_OUTLINE_TOOL_NAME } from "@/api/handlers/chat/tools/folio-agent-tools";
import { SEARCH_ALL_PAST_CHATS_TOOL_NAME } from "@/api/handlers/chat/tools/past-chat-tools";
import { WEB_SEARCH_TOOL_NAME } from "@/api/handlers/chat/tools/web-search-tools";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  NO_AUDIT,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createListUnavailableChatSkills } from "./list";

/**
 * A skill that declares `stella-required-tools` is offered in chat only when
 * chat has those tools. Asked about the widest chat, the endpoint names the
 * skills no chat of the caller can run. Asked about the composer's own chat,
 * it also names the skills that chat cannot run although another could, with
 * what the chat would have to change.
 */

const RUN = Bun.randomUUIDv7().slice(-10);

const SKILL = {
  browser: { slug: `browser-${RUN}`, tools: "use-browser" },
  counterparty: {
    slug: `counterparty-${RUN}`,
    tools: COUNTERPARTY_CHECK_TOOL_NAME,
  },
  // The outline tool runs in the file overlay's editor only.
  document: {
    slug: `outline-${RUN}`,
    tools: `${GET_DOCUMENT_OUTLINE_TOOL_NAME} suggest_changes`,
  },
  matterDocument: {
    slug: `matter-document-${RUN}`,
    tools: "create_matter_document",
  },
  nowhere: { slug: `nowhere-${RUN}`, tools: "no_chat_has_this_tool" },
  // Registered once the chat is about some matter: its own or a pinned one.
  pastChats: {
    slug: `past-chats-${RUN}`,
    tools: SEARCH_ALL_PAST_CHATS_TOOL_NAME,
  },
  plain: { slug: `plain-${RUN}`, tools: null },
  // Any open document's review queue resolves `suggest_changes`.
  redline: { slug: `redline-${RUN}`, tools: "suggest_changes" },
  webSearch: { slug: `web-${RUN}`, tools: WEB_SEARCH_TOOL_NAME },
} as const;
type SkillKey = keyof typeof SKILL;

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const skillIds = new Map<SkillKey, SafeId<"agentSkill">>();

// A deployment with a web-search provider, so the web-search switch is the
// only thing that decides whether chat has `web_search`.
const loadWebSearchProviders = async () => ({
  urlFetcher: null,
  webSearchProvider: {
    name: "tavily" as const,
    search: async () => await Promise.resolve({ results: [] }),
  },
});
const listUnavailableChatSkills = createListUnavailableChatSkills({
  loadWebSearchProviders,
});

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );

  for (const [key, { slug, tools }] of Object.entries(SKILL)) {
    const id = toSafeId<"agentSkill">(Bun.randomUUIDv7());
    skillIds.set(asTestRaw<SkillKey>(key), id);
    await testDb.insert(agentSkills).values({
      id,
      organizationId: ids.orgA,
      userId: ids.userA1,
      scope: "private",
      origin: "authored",
      slug,
      name: slug,
      description: `Skill ${slug}.`,
      metadata:
        tools === null ? {} : { [SKILL_REQUIRED_TOOLS_METADATA_KEY]: tools },
      contentHash: "0".repeat(64),
      body: `Follow ${slug}.`,
      command: slug,
      enabled: true,
    });
  }
});

afterAll(async () => {
  await testDb
    .delete(agentSkills)
    .where(inArray(agentSkills.id, [...skillIds.values()]));
  await releaseRlsFixture();
});

const WITH_MATTER = (): AccessibleWorkspace[] => [
  { id: ids.wsA1, status: "active" },
];

type ChatQuery = Parameters<
  typeof listUnavailableChatSkills.handler
>[0]["query"];

const call = async ({
  query = {},
  workspaces = WITH_MATTER(),
}: {
  query?: ChatQuery;
  workspaces?: AccessibleWorkspace[];
}) =>
  await listUnavailableChatSkills.handler(
    createTestHandlerContext<
      Parameters<typeof listUnavailableChatSkills.handler>[0]
    >({
      audit: NO_AUDIT,
      getAccessibleWorkspaces: async () => workspaces,
      getWorkspaceAccess: async (workspaceId) =>
        workspaces.find(({ id }) => id === workspaceId) ?? null,
      memberRole: sessionMemberRole("owner"),
      query,
      safeDb,
      scopedDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );

const skillKeyOf = (skillId: string): SkillKey | undefined =>
  [...skillIds].find(([, id]) => id === skillId)?.[0];

/** The seeded skills' decisions: hidden everywhere, and needs per skill here. */
const decide = async (options: Parameters<typeof call>[0]) => {
  const result = await call(options);
  if ("code" in result) {
    throw new TypeError(`expected the availability list, got ${result.code}`);
  }
  const unavailable = result.unavailable.flatMap(({ skillId }) => {
    const key = skillKeyOf(skillId);
    return key === undefined ? [] : [key];
  });
  const here: Partial<Record<SkillKey, readonly ChatSkillContextNeed[]>> = {};
  for (const { needs, skillId } of result.unavailableHere) {
    const key = skillKeyOf(skillId);
    if (key !== undefined) {
      here[key] = needs;
    }
  }
  return { here, unavailable: unavailable.toSorted() };
};

const NARROWEST = {
  anonymized: true,
  browserExtension: false,
  webSearch: false,
} satisfies ChatQuery;

const WIDEST = {
  anonymized: false,
  browserExtension: true,
  webSearch: true,
} satisfies ChatQuery;

describe("skills chat can offer", () => {
  test("a skill that writes into a matter is unavailable to a caller with none", async () => {
    expect(await decide({})).toEqual({ here: {}, unavailable: ["nowhere"] });
    expect(await decide({ workspaces: [] })).toEqual({
      here: {},
      unavailable: ["matterDocument", "nowhere", "pastChats"],
    });
  });

  test("the widest chat a caller opens can run every skill some chat can", async () => {
    expect(
      await decide({
        query: {
          ...WIDEST,
          document: CHAT_SKILL_DOCUMENT.file,
          documentId: ids.entityA1,
          editApplyMode: CHAT_EDIT_APPLY_MODE.manual,
          workspaceId: ids.wsA1,
        },
      }),
    ).toEqual({ here: {}, unavailable: ["nowhere"] });
  });

  test("a narrow chat names, per skill, the change that would let it run", async () => {
    expect(await decide({ query: NARROWEST })).toEqual({
      here: {
        browser: [CHAT_SKILL_CONTEXT_NEED.browserExtension],
        counterparty: [CHAT_SKILL_CONTEXT_NEED.rawSendMode],
        document: [CHAT_SKILL_CONTEXT_NEED.document],
        matterDocument: [CHAT_SKILL_CONTEXT_NEED.matter],
        pastChats: [CHAT_SKILL_CONTEXT_NEED.matter],
        redline: [CHAT_SKILL_CONTEXT_NEED.document],
        webSearch: [CHAT_SKILL_CONTEXT_NEED.webSearch],
      },
      // A skill no chat can run stays hidden, not "unavailable here".
      unavailable: ["nowhere"],
    });
  });

  test("turning web search on is the one change a web skill needs", async () => {
    const off = await decide({ query: { ...WIDEST, webSearch: false } });
    expect(off.here).toEqual({
      document: [CHAT_SKILL_CONTEXT_NEED.document],
      matterDocument: [CHAT_SKILL_CONTEXT_NEED.matter],
      pastChats: [CHAT_SKILL_CONTEXT_NEED.matter],
      redline: [CHAT_SKILL_CONTEXT_NEED.document],
      webSearch: [CHAT_SKILL_CONTEXT_NEED.webSearch],
    });
    const on = await decide({ query: WIDEST });
    expect(on.here.webSearch).toBeUndefined();
  });

  test("a template or an unsaved draft is not an open file", async () => {
    for (const document of [
      CHAT_SKILL_DOCUMENT.draft,
      CHAT_SKILL_DOCUMENT.template,
    ]) {
      const decided = await decide({
        query: {
          ...WIDEST,
          document,
          editApplyMode: CHAT_EDIT_APPLY_MODE.manual,
          workspaceId: ids.wsA1,
        },
      });
      // `suggest_changes` registers for both; the outline tool only with the
      // file overlay's editor.
      expect(decided.here).toEqual({
        document: [CHAT_SKILL_CONTEXT_NEED.document],
      });
    }
  });

  test("an open file whose edits apply directly can need review mode instead", async () => {
    // The send's default edit mode applies edits directly, which needs the
    // file's field; without it only the review queue offers `suggest_changes`.
    const decided = await decide({
      query: {
        ...WIDEST,
        document: CHAT_SKILL_DOCUMENT.file,
        documentId: ids.entityA1,
        workspaceId: ids.wsA1,
      },
    });
    expect(decided.here).toEqual({
      document: [CHAT_SKILL_CONTEXT_NEED.reviewEdits],
      redline: [CHAT_SKILL_CONTEXT_NEED.reviewEdits],
    });
  });

  test("a global chat drawing from a pinned matter searches that matter's chats", async () => {
    const unpinned = await decide({ query: WIDEST });
    expect(unpinned.here.pastChats).toEqual([CHAT_SKILL_CONTEXT_NEED.matter]);
    const pinned = await decide({
      query: { ...WIDEST, contextMatterIds: [ids.wsA1] },
    });
    expect(pinned.here.pastChats).toBeUndefined();
  });

  test("only an active matter lets a skill write into one", async () => {
    const archived = await decide({
      query: { ...WIDEST, workspaceId: ids.wsA2 },
      workspaces: [
        { id: ids.wsA1, status: "active" },
        { id: ids.wsA2, status: "archived" },
      ],
    });
    expect(archived.here.matterDocument).toEqual([
      CHAT_SKILL_CONTEXT_NEED.matter,
    ]);
    const active = await decide({
      query: { ...WIDEST, workspaceId: ids.wsA1 },
    });
    expect(active.here.matterDocument).toBeUndefined();
  });
});

describe("the composer's chat is authorized before it is evaluated", () => {
  test("a document outside the caller's matters is not found", async () => {
    for (const documentId of [ids.entityA2, ids.entityB1]) {
      expect(
        await call({
          query: {
            ...WIDEST,
            document: CHAT_SKILL_DOCUMENT.file,
            documentId,
          },
        }),
      ).toMatchObject({ code: 404 });
    }
  });

  test("a document from another matter than the chat's is not found", async () => {
    expect(
      await call({
        query: {
          ...WIDEST,
          document: CHAT_SKILL_DOCUMENT.file,
          documentId: ids.entityA2,
          workspaceId: ids.wsA1,
        },
        workspaces: [
          { id: ids.wsA1, status: "active" },
          { id: ids.wsA2, status: "active" },
        ],
      }),
    ).toMatchObject({ code: 404 });
  });

  test("a pinned matter the caller cannot reach is refused", async () => {
    expect(
      await call({ query: { ...WIDEST, contextMatterIds: [ids.wsB1] } }),
    ).toMatchObject({ code: 403 });
  });

  test("a matter the caller cannot reach is not found", async () => {
    expect(
      await call({ query: { ...WIDEST, workspaceId: ids.wsB1 } }),
    ).toMatchObject({ code: 404 });
  });

  test("a partial context is refused rather than guessed", async () => {
    expect(await call({ query: { webSearch: true } })).toMatchObject({
      code: 400,
    });
    expect(
      await call({ query: { ...WIDEST, documentId: ids.entityA1 } }),
    ).toMatchObject({ code: 400 });
    expect(
      await call({ query: { ...WIDEST, document: CHAT_SKILL_DOCUMENT.file } }),
    ).toMatchObject({ code: 400 });
  });
});

describe("built-in skills are decided beside installed ones", () => {
  // The shipped skills, each declaring a tool no chat has, so the decision
  // on them is visible; their names stay the shipped ones.
  const listUnmetBuiltIns = createListUnavailableChatSkills({
    listBuiltInSkills: () =>
      listSkillMetadata().map(({ description, name, version }) => ({
        description,
        metadata: { [SKILL_REQUIRED_TOOLS_METADATA_KEY]: SKILL.nowhere.tools },
        name,
        version,
      })),
    loadWebSearchProviders,
  });
  const builtInNames = listSkillMetadata().map(({ name }) => name);

  const unavailableIds = async () => {
    const result = await listUnmetBuiltIns.handler(
      createTestHandlerContext<Parameters<typeof listUnmetBuiltIns.handler>[0]>(
        {
          audit: NO_AUDIT,
          getAccessibleWorkspaces: async () => WITH_MATTER(),
          getWorkspaceAccess: async () => null,
          memberRole: sessionMemberRole("owner"),
          query: {},
          safeDb,
          scopedDb,
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userA1 },
        },
      ),
    );
    if ("code" in result) {
      throw new TypeError(`expected the availability list, got ${result.code}`);
    }
    return new Set(result.unavailable.map(({ skillId }) => skillId));
  };

  const withRowFor = async (
    slug: string,
    enabled: boolean,
    check: (rowId: SafeId<"agentSkill">) => Promise<void>,
  ) => {
    const id = toSafeId<"agentSkill">(Bun.randomUUIDv7());
    await testDb.insert(agentSkills).values({
      id,
      organizationId: ids.orgA,
      userId: ids.userA1,
      scope: "private",
      origin: "authored",
      slug,
      name: `Installed ${slug}`,
      description: "Installed under a built-in slug.",
      metadata: {},
      contentHash: "0".repeat(64),
      body: "Installed body.",
      enabled,
    });
    try {
      await check(id);
    } finally {
      await testDb.delete(agentSkills).where(eq(agentSkills.id, id));
    }
  };

  test("a built-in whose tools chat lacks is withheld under its slug", async () => {
    expect(builtInNames.length).toBeGreaterThan(0);
    const unavailable = await unavailableIds();
    for (const name of builtInNames) {
      expect(unavailable.has(name)).toBe(true);
    }
  });

  test("an enabled installed row with the slug is decided instead of the built-in", async () => {
    const name = builtInNames.at(0) ?? "";
    await withRowFor(name, true, async (rowId) => {
      const unavailable = await unavailableIds();
      expect(unavailable.has(name)).toBe(false);
      expect(unavailable.has(rowId)).toBe(false);
    });
    await withRowFor(name, false, async () => {
      expect((await unavailableIds()).has(name)).toBe(true);
    });
  });
});
