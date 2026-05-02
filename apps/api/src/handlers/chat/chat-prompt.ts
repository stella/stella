/**
 * System prompt builders for chat endpoints.
 *
 * Extracted from the chat actor so both the actor and the
 * REST chat endpoint can share the same prompt logic.
 */

import type { SkillMetadata } from "@stll/skills";
import { panic, Result } from "better-result";
import * as cheerio from "cheerio";
import { count, eq } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db";
import { caseLawDecisions, entities, workspaces } from "@/api/db/schema";
import type { PropertyStatus } from "@/api/db/schema";
import type { PropertyContent } from "@/api/db/schema-validators";
import { formatDecisionForPrompt } from "@/api/handlers/case-law/analysis/prompts/base";
import { parseDocumentAst } from "@/api/handlers/case-law/document-ast";
import type {
  IncomingActiveDecision,
  IncomingActiveFile,
  IncomingUserContext,
} from "@/api/handlers/chat/chat-schema";
import { getChatSkillMetadata } from "@/api/handlers/chat/skills";
import { readonlyOrgFunctionContracts } from "@/api/handlers/chat/tools/execute/org-manifest";
import { buildReadonlyFunctionTypeDeclarations } from "@/api/handlers/chat/tools/execute/readonly-manifest";
import type { ReadonlyFunctionContract } from "@/api/handlers/chat/tools/execute/readonly-manifest";
import {
  CHAT_ENTITY_REF_PREFIX,
  CHAT_WORKSPACE_REF_PREFIX,
} from "@/api/handlers/chat/tools/execute/ref-registry";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { readonlyWorkspaceFunctionContracts } from "@/api/handlers/chat/tools/execute/workspace-manifest";
import { CHAT_REFERENCE_HREF_PREFIXES } from "@/api/handlers/chat/types";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { formatDateTimeInTimeZone } from "@/api/lib/date-format";
import { unreachable } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedPropertyId } from "@/api/lib/safe-id-boundaries";

const TITLE_MAX_LENGTH = 80;
const ACTIVE_DECISION_MAX_CHARS = 12_000;

type BuildPromptMentionExampleProps = {
  label: string;
  prefix: string;
  id: string;
};

const buildPromptMentionExample = ({
  label,
  prefix,
  id,
}: BuildPromptMentionExampleProps) => `[${label}](${prefix}${id})`;

const CORE_RULE_SECTIONS = [
  "You are an AI feature inside a legal workspace product named " +
    "Stella. You retrieve documents, draft text, and answer " +
    "questions on behalf of the user. Stella is the product the " +
    "user works *in*; you are the AI *within* it — not a persona " +
    "called Stella.",
  "CRITICAL: Never guess, infer, or fabricate document " +
    "content. Always retrieve real data through the " +
    "`execute-typescript` tool and the typed readonly `stella` " +
    "API before answering. If a tool call fails, report the " +
    "error honestly.",
  "IDENTITY: Do not introduce yourself, name yourself, or refer " +
    "to yourself with a persona. Never write greetings like " +
    "'Hi, I am Stella' or 'I'm your AI assistant' — the user " +
    "knows what they opened. Skip the preamble and answer " +
    "directly. When drafting documents, emails, or letters, " +
    "sign using the user's registered name (provided below); " +
    "the user is the author. Never present yourself as an " +
    "entity with opinions, feelings, or independent judgment.",
  "PLANNING: For complex or ambiguous tasks (drafting " +
    "documents, multi-step workflows), call ask-user to " +
    "gather requirements BEFORE acting. Wait for the " +
    "user's response, then synthesize a plan and execute.",
  "Never expose internal IDs to the user in plain text. " +
    "Tool outputs include short refs so you can create links. " +
    "When a tool output includes a `mention` field, copy that exact " +
    "`mention` markdown whenever you name that object in a user-facing " +
    "answer. Do not rewrite it as plain text. " +
    "When mentioning a matter, document, folder, task, case-law " +
    "decision, or other Stella object, show only the human label " +
    "and encode the ref in a markdown link.",
  `When citing documents and matters, use markdown links:
${buildPromptMentionExample({
  label: "Document Name",
  prefix: CHAT_ENTITY_REF_PREFIX,
  id: "ent_1",
})}
${buildPromptMentionExample({
  label: "Matter Name",
  prefix: CHAT_WORKSPACE_REF_PREFIX,
  id: "mat_1",
})}
For folders and tasks, use the same entity link format:
${buildPromptMentionExample({
  label: "Folder Name",
  prefix: CHAT_ENTITY_REF_PREFIX,
  id: "ent_2",
})}
Do not write forms like "Document Name (ent_1)" or expose refs/UUIDs in parentheses.
When citing case-law decisions, use markdown links like:
${buildPromptMentionExample({
  label: "20 Cdo 470/2017",
  prefix: CHAT_REFERENCE_HREF_PREFIXES.decision,
  id: "CASE_LAW_DECISION_ID",
})}
If you only know the case number and not the decision ID, still link it as:
[20 Cdo 470/2017](#stella-decision=20%20Cdo%20470%2F2017)`,
] as const;

export type UserContext = IncomingUserContext;

export type ChatPromptParts = {
  cacheStablePrefix: string;
  fullPrompt: string;
};

export const buildChatPromptCacheKey = (cacheStablePrefix: string) => {
  const hash = new Bun.CryptoHasher("sha256")
    .update(cacheStablePrefix)
    .digest("hex")
    .slice(0, 24);

  return `stella-chat:v1:${hash}`;
};

type BuildChatSystemPromptProps = {
  activeDecision: IncomingActiveDecision | undefined;
  activeFile: IncomingActiveFile | undefined;
  /**
   * Matters this chat draws context from. Empty means "no
   * specific matters pinned" — the AI is told to discover
   * relevant matters on demand. Non-empty narrows the AI's
   * declared scope to those matters' refs (tool authorisation
   * also enforces the constraint at call time).
   */
  contextMatterIds: SafeId<"workspace">[];
  refRegistry: ChatRefRegistry;
  safeDb: SafeDb;
  userContext: IncomingUserContext | undefined;
  workspaceId: SafeId<"workspace"> | null;
};

export const buildChatSystemPrompt = async (
  props: BuildChatSystemPromptProps,
): Promise<Result<string, SafeDbError>> =>
  (await buildChatSystemPromptParts(props)).map(({ fullPrompt }) => fullPrompt);

export const buildChatSystemPromptParts = async ({
  activeDecision,
  activeFile,
  contextMatterIds,
  refRegistry,
  safeDb,
  userContext,
  workspaceId,
}: BuildChatSystemPromptProps): Promise<Result<ChatPromptParts, SafeDbError>> =>
  await Result.gen(async function* () {
    if (workspaceId === null) {
      const prompt = buildGlobalPromptParts({
        readonlyStellaApi: buildReadonlyStellaApi({
          contracts: [
            ...readonlyOrgFunctionContracts,
            ...readonlyWorkspaceFunctionContracts,
          ],
        }),
        skillMetadata: getChatSkillMetadata(),
        userContext: userContext ?? null,
      });

      const decisionPrompt = yield* Result.await(
        appendActiveDecisionPromptIfExists({
          activeDecision,
          prompt: prompt.fullPrompt,
          safeDb,
        }),
      );
      return Result.ok({
        cacheStablePrefix: prompt.cacheStablePrefix,
        fullPrompt: appendContextMatterScope({
          contextMatterIds,
          prompt: decisionPrompt,
          refRegistry,
          scope: "global",
        }),
      });
    }

    const prompt = yield* Result.await(
      buildWorkspacePromptPartsFromDb({
        refRegistry,
        safeDb,
        userContext: userContext ?? null,
        workspaceId,
      }),
    );

    const decisionPrompt = yield* Result.await(
      appendActiveDecisionPromptIfExists({
        activeDecision,
        prompt: prompt.fullPrompt,
        safeDb,
      }),
    );

    const scopedPrompt = appendContextMatterScope({
      contextMatterIds,
      prompt: decisionPrompt,
      refRegistry,
      scope: "workspace",
      workspaceId,
    });

    if (!activeFile) {
      return Result.ok({
        cacheStablePrefix: prompt.cacheStablePrefix,
        fullPrompt: scopedPrompt,
      });
    }

    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: activeFile.entityId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
        }),
      ),
    );

    return Result.ok({
      cacheStablePrefix: prompt.cacheStablePrefix,
      fullPrompt: appendActiveFilePromptIfEntityExists({
        activeFile,
        entityExists: Boolean(entity),
        prompt: scopedPrompt,
        refRegistry,
        workspaceId,
      }),
    });
  });

type AppendContextMatterScopeProps =
  | {
      contextMatterIds: SafeId<"workspace">[];
      prompt: string;
      refRegistry: ChatRefRegistry;
      scope: "global";
      workspaceId?: undefined;
    }
  | {
      contextMatterIds: SafeId<"workspace">[];
      prompt: string;
      refRegistry: ChatRefRegistry;
      scope: "workspace";
      workspaceId: SafeId<"workspace">;
    };

/**
 * Append a "matter context" instruction block based on what the
 * caller pinned. Empty list → tell the model to discover via
 * tools. Non-empty → list the matterRefs in scope and tell the
 * model to constrain matter-scoped function calls accordingly.
 * For workspace-scoped chats the chat's own matter is implicit;
 * we surface it alongside any extras so the AI sees the full set.
 */
const appendContextMatterScope = ({
  contextMatterIds,
  prompt,
  refRegistry,
  scope,
  workspaceId,
}: AppendContextMatterScopeProps): string => {
  // Workspace-scoped chats already include "Connected to matter X"
  // and a default `matterRefs: ["X"]` instruction in the matter
  // prompt. Empty contextMatterIds is the no-op case there.
  if (scope === "workspace" && contextMatterIds.length === 0) {
    return prompt;
  }

  // Effective set: for workspace chats we include the chat's own
  // matter alongside any extras the user pinned, deduplicated and
  // stable-ordered.
  const effective =
    scope === "workspace"
      ? Array.from(
          new Set<SafeId<"workspace">>([workspaceId, ...contextMatterIds]),
        )
      : contextMatterIds;

  if (effective.length === 0) {
    return [
      prompt,
      "MATTER SCOPE: No matters are pinned to this chat. The user may ask about anything across the matters they can access. Discover relevant matters with `stella.listMatters` (paginated) or `stella.searchEntities` before answering — do NOT ask the user to name a matter unless the question is genuinely ambiguous after lookup.",
    ].join("\n\n");
  }

  const refs = effective.map((id) => refRegistry.toMatterRef(id));
  const refList = refs.map((ref) => `"${ref}"`).join(", ");
  const heading =
    effective.length === 1
      ? "MATTER SCOPE: This chat is pinned to one matter."
      : `MATTER SCOPE: This chat is pinned to ${effective.length} matters.`;
  return [
    prompt,
    [
      heading,
      `Restrict matter-scoped function calls (\`stella.list*\`, \`stella.search*\`, \`stella.get*\`) to \`matterRefs: [${refList}]\`. Do NOT call them with matter refs outside this set — even if the user names another matter, surface that as a clarification instead of widening scope yourself.`,
    ].join("\n"),
  ].join("\n\n");
};

export const extractTitle = (parts: ChatMessage["parts"]) => {
  const raw = parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  const plainText = cheerio
    .load(raw, undefined, false)
    .text()
    .replaceAll(/\s+/g, " ")
    .trim();

  if (plainText.length > TITLE_MAX_LENGTH) {
    return `${plainText.slice(0, TITLE_MAX_LENGTH)}…`;
  }

  return plainText || "New chat";
};

type BuildGlobalPromptProps = {
  readonlyStellaApi: string;
  skillMetadata?: readonly SkillMetadata[] | undefined;
  userContext: UserContext | null;
};

export const buildGlobalPrompt = ({
  readonlyStellaApi,
  skillMetadata = getChatSkillMetadata(),
  userContext,
}: BuildGlobalPromptProps) =>
  buildGlobalPromptParts({
    readonlyStellaApi,
    skillMetadata,
    userContext,
  }).fullPrompt;

export const buildGlobalPromptParts = ({
  readonlyStellaApi,
  skillMetadata = getChatSkillMetadata(),
  userContext,
}: BuildGlobalPromptProps): ChatPromptParts =>
  buildPromptParts({
    cacheStableContextSections:
      buildCacheStableReadonlyToolSections(readonlyStellaApi),
    requestContextSections: [],
    skillMetadata,
    userContext,
  });

type BuildWorkspacePromptProps = {
  refRegistry: ChatRefRegistry;
  safeDb: SafeDb;
  userContext: UserContext | null;
  workspaceId: SafeId<"workspace">;
};

const buildWorkspacePromptPartsFromDb = async ({
  refRegistry,
  safeDb,
  userContext,
  workspaceId,
}: BuildWorkspacePromptProps): Promise<Result<ChatPromptParts, SafeDbError>> =>
  await Result.gen(async function* () {
    const workspacePromptData = yield* Result.await(
      loadWorkspacePromptData({
        safeDb,
        workspaceId,
      }),
    );

    return Result.ok(
      buildWorkspacePromptParts({
        entityCount: workspacePromptData.entityCount,
        properties: workspacePromptData.properties,
        refRegistry,
        readonlyStellaApi: buildReadonlyStellaApi({
          contracts: [
            ...readonlyOrgFunctionContracts,
            ...readonlyWorkspaceFunctionContracts,
          ],
        }),
        skillMetadata: getChatSkillMetadata(),
        userContext,
        workspaceId,
        workspaceName: workspacePromptData.workspaceName,
      }),
    );
  });

export type WorkspacePromptProperty = {
  content: PropertyContent;
  id: string;
  name: string;
  status: PropertyStatus;
};

type WorkspacePromptData = {
  entityCount: number;
  properties: WorkspacePromptProperty[];
  workspaceName: string;
};

type LoadWorkspacePromptDataProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
};

const loadWorkspacePromptData = async ({
  safeDb,
  workspaceId,
}: LoadWorkspacePromptDataProps): Promise<
  Result<WorkspacePromptData, SafeDbError>
> =>
  await Result.gen(async function* () {
    const [workspaceRows, properties] = yield* Result.await(
      safeDb(
        async (tx) =>
          await Promise.all([
            tx
              .select({
                entityCount: count(entities.id),
                workspaceName: workspaces.name,
              })
              .from(workspaces)
              .leftJoin(entities, eq(entities.workspaceId, workspaces.id))
              .where(eq(workspaces.id, workspaceId))
              .groupBy(workspaces.id, workspaces.name),
            tx.query.properties.findMany({
              where: { workspaceId: { eq: workspaceId } },
              columns: {
                id: true,
                name: true,
                status: true,
                content: true,
              },
            }),
          ]),
      ),
    );

    const workspaceRow = workspaceRows.at(0);
    if (!workspaceRow) {
      panic("Workspace prompt query returned no rows");
    }

    return Result.ok({
      entityCount: workspaceRow.entityCount,
      properties,
      workspaceName: workspaceRow.workspaceName,
    });
  });

type BuildWorkspaceContextSectionsProps = {
  entityCount: number;
  properties: WorkspacePromptProperty[];
  refRegistry: ChatRefRegistry;
  workspaceId: SafeId<"workspace">;
  workspaceName: string;
};

const buildWorkspaceContextSections = ({
  entityCount,
  properties,
  refRegistry,
  workspaceId,
  workspaceName,
}: BuildWorkspaceContextSectionsProps): string[] => {
  const matterRef = refRegistry.toMatterRef(workspaceId);
  const sections = [
    `Connected to matter "${workspaceName}".`,
    "SCOPE: Matter-scoped `stella` functions require explicit " +
      "`matterRefs` inputs. In this matter, default to " +
      `\`matterRefs: ["${matterRef}"]\` unless the user asks to work across matters.`,
    [
      `Current matter ref: ${matterRef} (pass as matterRefs: ["${matterRef}"]).`,
      `The matter contains ${entityCount.toLocaleString()} entities.`,
    ].join("\n"),
  ];

  const metadataColumnsSection = buildMetadataColumnsSection({
    properties,
    refRegistry,
  });
  if (metadataColumnsSection) {
    sections.push(metadataColumnsSection);
  }

  return sections;
};

const buildMetadataColumnsSection = ({
  properties,
  refRegistry,
}: {
  properties: readonly WorkspacePromptProperty[];
  refRegistry: ChatRefRegistry;
}) => {
  // Hide properties whose value isn't current — for AI properties
  // that means waiting for the next workflow run. Manual properties
  // are always fresh from creation, so they always show through.
  const propertyLines = properties
    .filter(({ status }) => status === "fresh")
    .map((property) =>
      formatMetadataColumnLine({
        property,
        refRegistry,
      }),
    );

  if (propertyLines.length === 0) {
    return null;
  }

  return [
    "Available metadata columns:",
    propertyLines.join("\n"),
    "",
    "Modify metadata with update-entity-fields; " +
      "create DOCX documents with create-document. " +
      "Both require user approval.",
  ].join("\n");
};

const formatMetadataColumnLine = ({
  property: { content, id, name },
  refRegistry,
}: {
  property: WorkspacePromptProperty;
  refRegistry: ChatRefRegistry;
}) => {
  const optionValues = getPropertyOptionValues(content);
  const propertyRef = refRegistry.toPropertyRef(brandPersistedPropertyId(id));
  const baseLine = `- ${name} (ref: ${propertyRef}, type: ${content.type})`;

  if (!optionValues) {
    return baseLine;
  }

  return `${baseLine} [options: ${optionValues}]`;
};

const getPropertyOptionValues = (content: PropertyContent) => {
  switch (content.type) {
    case "single-select":
    case "multi-select":
      return content.options.map(({ value }) => value).join(", ");
    case "date":
    case "file":
    case "int":
    case "text":
      return null;
    default: {
      return unreachable("Unknown property type");
    }
  }
};

type BuildWorkspacePromptTextProps = {
  entityCount: number;
  properties: WorkspacePromptProperty[];
  refRegistry: ChatRefRegistry;
  readonlyStellaApi: string;
  skillMetadata?: readonly SkillMetadata[] | undefined;
  userContext: UserContext | null;
  workspaceId: SafeId<"workspace">;
  workspaceName: string;
};

export const buildWorkspacePromptText = ({
  entityCount,
  properties,
  refRegistry,
  readonlyStellaApi,
  skillMetadata = getChatSkillMetadata(),
  userContext,
  workspaceId,
  workspaceName,
}: BuildWorkspacePromptTextProps) =>
  buildWorkspacePromptParts({
    entityCount,
    properties,
    refRegistry,
    readonlyStellaApi,
    skillMetadata,
    userContext,
    workspaceId,
    workspaceName,
  }).fullPrompt;

export const buildWorkspacePromptParts = ({
  entityCount,
  properties,
  refRegistry,
  readonlyStellaApi,
  skillMetadata = getChatSkillMetadata(),
  userContext,
  workspaceId,
  workspaceName,
}: BuildWorkspacePromptTextProps): ChatPromptParts =>
  buildPromptParts({
    cacheStableContextSections:
      buildCacheStableReadonlyToolSections(readonlyStellaApi),
    requestContextSections: buildWorkspaceContextSections({
      entityCount,
      properties,
      refRegistry,
      workspaceId,
      workspaceName,
    }),
    skillMetadata,
    userContext,
  });

type BuildActiveFilePromptProps = {
  activeFile: IncomingActiveFile;
  refRegistry: ChatRefRegistry;
  workspaceId: SafeId<"workspace">;
};

const buildActiveFilePrompt = ({
  activeFile,
  refRegistry,
  workspaceId,
}: BuildActiveFilePromptProps) => {
  const safeName = sanitizePromptValue({
    maxLength: 200,
    text: activeFile.fileName,
  });
  const entityRef = refRegistry.toEntityRef({
    entityId: activeFile.entityId,
    workspaceId,
  });
  const matterRef = refRegistry.toMatterRef(workspaceId);

  return [
    `ACTIVE FILE: The user is viewing "${safeName}" (entity ref ${entityRef}) in the inspector sidebar.`,
    `DEFAULT SCOPE: While an active file is set, treat it as the sole subject of any open-ended question ("what's going on", "summarize this", "what does it say", "explain", and similar). Read its contents with \`stella.getMatterEntityContents\` using \`matterRefs: ["${matterRef}"]\` and \`entityRefs: ["${entityRef}"]\`, and answer ONLY from that file.`,
    `Do NOT call matter-wide retrieval (\`stella.searchEntities\`, \`stella.listEntities\`, or \`stella.getMatterEntities\`) for these open-ended questions — the user does not want answers synthesised from other files in the matter. The chat history is always available; reference earlier turns directly without re-fetching.`,
    `Widen the scope to the rest of the matter ONLY when the user explicitly asks (e.g., "compare with the other contracts", "search across the matter", or names another document). When that happens, the matter-wide retrieval functions above are allowed again; scope them to \`matterRefs: ["${matterRef}"]\` as usual.`,
  ].join("\n");
};

type BuildActiveDecisionPromptProps = {
  caseNumber: string;
  court: string;
  country: string | null;
  decisionDate: string | null;
  decisionId: SafeId<"caseLawDecision">;
  decisionText: string;
  decisionType: string | null;
};

const buildActiveDecisionPrompt = ({
  caseNumber,
  court,
  country,
  decisionDate,
  decisionId,
  decisionText,
  decisionType,
}: BuildActiveDecisionPromptProps) =>
  [
    `The user is currently viewing case-law decision "${sanitizePromptValue({
      maxLength: 200,
      text: caseNumber,
    })}".`,
    `Reference it as ${buildPromptMentionExample({
      label: sanitizePromptValue({ maxLength: 200, text: caseNumber }),
      prefix: CHAT_REFERENCE_HREF_PREFIXES.decision,
      id: decisionId,
    })}.`,
    [
      `Court: ${sanitizePromptValue({ maxLength: 200, text: court })}`,
      country
        ? `Country: ${sanitizePromptValue({ maxLength: 80, text: country })}`
        : null,
      decisionType
        ? `Decision type: ${sanitizePromptValue({
            maxLength: 120,
            text: decisionType,
          })}`
        : null,
      decisionDate ? `Decision date: ${decisionDate}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    "When the user refers to this case, this decision, or the open case-law document, use the following current decision text. Do not answer from a previous matter unless the user explicitly asks about that matter.",
    decisionText,
  ].join("\n\n");

type AppendActiveDecisionPromptIfExistsProps = {
  activeDecision: IncomingActiveDecision | undefined;
  prompt: string;
  safeDb: SafeDb;
};

const appendActiveDecisionPromptIfExists = async ({
  activeDecision,
  prompt,
  safeDb,
}: AppendActiveDecisionPromptIfExistsProps): Promise<
  Result<string, SafeDbError>
> =>
  await Result.gen(async function* () {
    if (!activeDecision) {
      return Result.ok(prompt);
    }

    const decision = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            caseNumber: caseLawDecisions.caseNumber,
            country: caseLawDecisions.country,
            court: caseLawDecisions.court,
            decisionDate: caseLawDecisions.decisionDate,
            decisionId: caseLawDecisions.id,
            decisionType: caseLawDecisions.decisionType,
            documentAst: caseLawDecisions.documentAst,
            fulltext: caseLawDecisions.fulltext,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, activeDecision.decisionId))
          .limit(1),
      ),
    );

    const row = decision.at(0);
    if (!row) {
      return Result.ok(prompt);
    }

    const ast = parseDocumentAst(row.documentAst);
    const sourceText = ast
      ? formatDecisionForPrompt(ast.blocks)
      : (row.fulltext ?? "");
    const decisionText = sourceText.slice(0, ACTIVE_DECISION_MAX_CHARS);

    return Result.ok(
      `${prompt}\n\n${buildActiveDecisionPrompt({
        caseNumber: row.caseNumber,
        country: row.country,
        court: row.court,
        decisionDate: row.decisionDate,
        decisionId: row.decisionId,
        decisionText,
        decisionType: row.decisionType,
      })}`,
    );
  });

type BuildReadonlyStellaApiProps = {
  contracts: readonly ReadonlyFunctionContract[];
};

const buildReadonlyStellaApi = ({
  contracts,
}: BuildReadonlyStellaApiProps): string =>
  buildReadonlyFunctionTypeDeclarations(contracts).match({
    err: (error) => panic(error.message),
    ok: (value) => value,
  });

const buildCacheStableReadonlyToolSections = (
  readonlyStellaApi: string,
): string[] => [
  "Use `execute-typescript` for readonly retrieval. The readonly " +
    "`stella` API available inside `execute-typescript` is typed below.",
  "The readonly `stella` API uses matter naming. Matter-scoped " +
    "functions require explicit `matterRefs` inputs.",
  "`stella.list*` functions accept optional `limit` and numeric " +
    "`offset` pagination inputs. Omit `limit` unless you need a smaller " +
    "page; the server defaults it and caps it at 500.",
  "`stella.get*` functions require explicit refs and return full " +
    `results without pagination. Detail reads accept up to ${LIMITS.chatExecuteDetailIdsMax} refs; ` +
    `content reads accept up to ${LIMITS.chatExecuteContentIdsMax} entity refs.`,
  "Prefer one batched `get*` call over many small calls when you " +
    "already know the matter or entity refs you need.",
  "Use `describe-stella-function` only as a fallback if you " +
    "need the full JSON Schema details for one function.",
  "Inside `execute-typescript`, `console.log` is a no-op: " +
    "only the value your program `return`s comes back.",
  ["Readonly `stella` API:", "```ts", readonlyStellaApi, "```"].join("\n"),
];

type AppendActiveFilePromptIfEntityExistsProps = {
  activeFile: IncomingActiveFile;
  entityExists: boolean;
  prompt: string;
  refRegistry: ChatRefRegistry;
  workspaceId: SafeId<"workspace">;
};

export const appendActiveFilePromptIfEntityExists = ({
  activeFile,
  entityExists,
  prompt,
  refRegistry,
  workspaceId,
}: AppendActiveFilePromptIfEntityExistsProps) =>
  entityExists
    ? `${prompt}\n\n${buildActiveFilePrompt({
        activeFile,
        refRegistry,
        workspaceId,
      })}`
    : prompt;

type BuildPromptProps = {
  cacheStableContextSections: string[];
  requestContextSections: string[];
  skillMetadata: readonly SkillMetadata[];
  userContext: UserContext | null;
};

const buildPromptParts = ({
  cacheStableContextSections,
  requestContextSections,
  skillMetadata,
  userContext,
}: BuildPromptProps): ChatPromptParts => {
  const cacheStablePrefix = joinPromptSections([
    ...CORE_RULE_SECTIONS,
    buildSkillCatalogSection(skillMetadata),
    ...cacheStableContextSections,
  ]);
  const sections = [cacheStablePrefix, ...requestContextSections];
  const userContextBlock = buildUserContextBlock(userContext);

  if (userContextBlock) {
    sections.push(userContextBlock);
  }

  return {
    cacheStablePrefix,
    fullPrompt: joinPromptSections(sections),
  };
};

const joinPromptSections = (sections: readonly string[]) =>
  sections.filter((section) => section.length > 0).join("\n\n");

const buildSkillCatalogSection = (skillMetadata: readonly SkillMetadata[]) => {
  if (skillMetadata.length === 0) {
    return "";
  }

  const skillLines = skillMetadata
    .map((skill) => {
      const version = skill.version ? ` (version ${skill.version})` : "";
      return `- ${skill.name}: ${skill.description}${version}`;
    })
    .join("\n");

  return [
    "Available Stella skills are listed below by name and description only.",
    "Use `load-skill` before applying a skill's detailed methodology. " +
      "Use `read-skill-resource` only for resource paths returned by `load-skill`.",
    "Skills provide reasoning methodology and templates; they do not grant data access.",
    skillLines,
  ].join("\n");
};

export const buildUserContextBlock = (userContext: UserContext | null) => {
  if (!userContext) {
    return "";
  }

  const lines = [`User registered as: ${userContext.userName}`];

  if (userContext.timezone) {
    lines.push(
      `Current date/time: ${formatDateTimeInTimeZone({
        timezone: userContext.timezone,
      })} (${userContext.timezone})`,
    );
  }

  return lines.join("\n");
};

type SanitizePromptValueProps = {
  maxLength: number;
  text: string;
};

const sanitizePromptValue = ({ maxLength, text }: SanitizePromptValueProps) =>
  text.replace(/[\r\n]/g, " ").slice(0, maxLength);
