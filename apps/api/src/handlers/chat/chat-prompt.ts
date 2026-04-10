/**
 * System prompt builders for chat endpoints.
 *
 * Extracted from the chat actor so both the actor and the
 * REST chat endpoint can share the same prompt logic.
 */

import { panic, Result } from "better-result";
import * as cheerio from "cheerio";
import { count, eq } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db";
import { entities, workspaces } from "@/api/db/schema";
import type { PropertyStatus } from "@/api/db/schema";
import type { PropertyContent } from "@/api/db/schema-validators";
import type {
  IncomingActiveFile,
  IncomingUserContext,
} from "@/api/handlers/chat/chat-schema";
import type {
  ChatMentionHrefPrefix,
  ChatMessage,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { formatDateTimeInTimeZone } from "@/api/lib/date-format";
import { unreachable } from "@/api/lib/errors/tagged-errors";

const TITLE_MAX_LENGTH = 80;
const UNINITIALIZED_PROPERTY_STATUS = "uninitialized";

type BuildPromptMentionExampleProps = {
  label: string;
  prefix: ChatMentionHrefPrefix;
  id: string;
};

const buildPromptMentionExample = ({
  label,
  prefix,
  id,
}: BuildPromptMentionExampleProps) => `[${label}](${prefix}${id})`;

const CORE_RULE_SECTIONS = [
  "You are AI within a legal workspace product called " +
    "Stella. You retrieve documents, draft text, and " +
    "answer questions on behalf of the user.",
  "CRITICAL: Never guess, infer, or fabricate document " +
    "content. Always call read-content (or the appropriate " +
    "tool) to retrieve real data before answering. If a " +
    "tool call fails, report the error honestly.",
  "IDENTITY: When drafting documents, emails, or letters, " +
    "always sign using the user's registered name (provided " +
    "below). The user is the author. Never refer to yourself " +
    "by name or present yourself as an entity with opinions, " +
    "feelings, or independent judgment.",
  "PLANNING: For complex or ambiguous tasks (drafting " +
    "documents, multi-step workflows), call ask-user to " +
    "gather requirements BEFORE acting. Wait for the " +
    "user's response, then synthesize a plan and execute.",
  "Never expose internal IDs to the user in plain text.",
  `When citing documents and matters, use markdown links:
${buildPromptMentionExample({
  label: "Document Name",
  prefix: "#stella-entity=",
  id: "ENTITY_ID",
})}
${buildPromptMentionExample({
  label: "Matter Name",
  prefix: "#stella-workspace=",
  id: "WORKSPACE_ID",
})}`,
] as const;

export type UserContext = IncomingUserContext;

type BuildChatSystemPromptProps = {
  activeFile: IncomingActiveFile | undefined;
  safeDb: SafeDb;
  userContext: IncomingUserContext | undefined;
  workspaceId: SafeId<"workspace"> | null;
};

export const buildChatSystemPrompt = async ({
  activeFile,
  safeDb,
  userContext,
  workspaceId,
}: BuildChatSystemPromptProps): Promise<Result<string, SafeDbError>> =>
  await Result.gen(async function* () {
    if (workspaceId === null) {
      return Result.ok(buildGlobalPrompt({ userContext: userContext ?? null }));
    }

    const prompt = yield* Result.await(
      buildWorkspacePrompt({
        safeDb,
        userContext: userContext ?? null,
        workspaceId,
      }),
    );

    if (!activeFile) {
      return Result.ok(prompt);
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

    return Result.ok(
      appendActiveFilePromptIfEntityExists({
        activeFile,
        entityExists: Boolean(entity),
        prompt,
      }),
    );
  });

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
  userContext: UserContext | null;
};

export const buildGlobalPrompt = ({ userContext }: BuildGlobalPromptProps) =>
  buildPrompt({
    contextSections: [
      "You have tools to search across all matters, look " +
        "up contacts, browse templates, and read clauses. " +
        "Use them when the user asks about " +
        "their data. Never ask the user to call tools; " +
        "just use them.",
    ],
    userContext,
  });

type BuildWorkspacePromptProps = {
  safeDb: SafeDb;
  userContext: UserContext | null;
  workspaceId: SafeId<"workspace">;
};

const buildWorkspacePrompt = async ({
  safeDb,
  userContext,
  workspaceId,
}: BuildWorkspacePromptProps): Promise<Result<string, SafeDbError>> =>
  await Result.gen(async function* () {
    const workspacePromptData = yield* Result.await(
      loadWorkspacePromptData({
        safeDb,
        workspaceId,
      }),
    );

    return Result.ok(
      buildWorkspacePromptText({
        entityCount: workspacePromptData.entityCount,
        properties: workspacePromptData.properties,
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
  workspaceId: SafeId<"workspace">;
  workspaceName: string;
};

const buildWorkspaceContextSections = ({
  entityCount,
  properties,
  workspaceId,
  workspaceName,
}: BuildWorkspaceContextSectionsProps): string[] => {
  const sections = [
    `Connected to matter "${workspaceName}".`,
    "Use the available tools (search-matter, " +
      "search-content, list-entities, read-entity, read-content) " +
      "to retrieve real data. Never ask the " +
      "user to call tools; just use them.",
    "SCOPE: By default, use matter-scoped tools for " +
      "this matter. Only use search-across-matters / " +
      "read-content-across-matters when the user " +
      'EXPLICITLY asks to search outside (e.g. "across ' +
      'matters", "in other cases").',
    [
      `Workspace ID: ${workspaceId} (pass as workspaceId).`,
      `The matter contains ${entityCount.toLocaleString()} entities.`,
    ].join("\n"),
  ];

  const metadataColumnsSection = buildMetadataColumnsSection(properties);
  if (metadataColumnsSection) {
    sections.push(metadataColumnsSection);
  }

  return sections;
};

const buildMetadataColumnsSection = (properties: WorkspacePromptProperty[]) => {
  const propertyLines = properties
    .filter(({ status }) => status !== UNINITIALIZED_PROPERTY_STATUS)
    .map(formatMetadataColumnLine);

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
  content,
  id,
  name,
}: WorkspacePromptProperty) => {
  const optionValues = getPropertyOptionValues(content);
  const baseLine = `- ${name} (id: ${id}, type: ${content.type})`;

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
  userContext: UserContext | null;
  workspaceId: SafeId<"workspace">;
  workspaceName: string;
};

export const buildWorkspacePromptText = ({
  entityCount,
  properties,
  userContext,
  workspaceId,
  workspaceName,
}: BuildWorkspacePromptTextProps) =>
  buildPrompt({
    contextSections: buildWorkspaceContextSections({
      entityCount,
      properties,
      workspaceId,
      workspaceName,
    }),
    userContext,
  });

type BuildActiveFilePromptProps = {
  activeFile: IncomingActiveFile;
};

const buildActiveFilePrompt = ({ activeFile }: BuildActiveFilePromptProps) => {
  const safeName = sanitizePromptValue({
    maxLength: 200,
    text: activeFile.fileName,
  });
  const safeEntityId = sanitizePromptValue({
    maxLength: 100,
    text: activeFile.entityId,
  });

  return [
    `The user is currently viewing "${safeName}" in the inspector sidebar.`,
    `When they refer to "this document" or "the open file", they mean entity ${safeEntityId}.`,
    `Use read-entity or read-content with this entity ID to access its data.`,
  ].join("\n");
};

type AppendActiveFilePromptIfEntityExistsProps = {
  activeFile: IncomingActiveFile;
  entityExists: boolean;
  prompt: string;
};

export const appendActiveFilePromptIfEntityExists = ({
  activeFile,
  entityExists,
  prompt,
}: AppendActiveFilePromptIfEntityExistsProps) =>
  entityExists
    ? `${prompt}\n\n${buildActiveFilePrompt({ activeFile })}`
    : prompt;

type BuildPromptProps = {
  contextSections: string[];
  userContext: UserContext | null;
};

const buildPrompt = ({ contextSections, userContext }: BuildPromptProps) => {
  const sections = [...CORE_RULE_SECTIONS, ...contextSections];
  const userContextBlock = buildUserContextBlock(userContext);

  if (userContextBlock) {
    sections.push(userContextBlock);
  }

  return sections.join("\n\n");
};

export const buildUserContextBlock = (userContext: UserContext | null) => {
  if (!userContext) {
    return "";
  }

  const lines = [`User registered as: ${userContext.userName}`];

  if (userContext.locale) {
    lines.push(`UX language: ${userContext.locale}`);
  }

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
