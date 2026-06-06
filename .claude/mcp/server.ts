import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// eslint-disable-next-line no-restricted-imports -- MCP SDK tool schemas use zod.
import { z } from "zod";

import {
  fetchAllowedUrl,
  isAllowedDocUrl as isAllowedDocUrlForHosts,
} from "./fetch-allowed-url";

const SOURCES: Record<string, string> = {
  Elysia: "https://elysiajs.com/llms.txt",
  Drizzle: "https://orm.drizzle.team/llms.txt",
  TanStack: "https://tanstack.com/llms.txt",
  TanStackStart:
    "https://tanstack.com/start/latest/docs/framework/react/overview.md",
  React: "https://react.dev/llms.txt",
  BaseUI: "https://base-ui.com/llms.txt",
  AISDK: "https://ai-sdk.dev/llms.txt",
  WXT: "https://wxt.dev/llms.txt",
  AtlassianDesign: "https://atlassian.design/llms.txt",
  Valibot: "https://valibot.dev/llms.txt",
  Zod: "https://zod.dev/llms.txt",
  TipTap: "https://tiptap.dev/llms.txt",
  Bun: "https://bun.sh/llms.txt",
  BetterAuth: "https://www.better-auth.com/llms.txt",
  Turborepo: "https://turborepo.dev/llms.txt",
  Rivet: "https://rivet.dev/llms.txt",
  PostHog: "https://posthog.com/llms.txt",
  Zustand: "https://zustand.docs.pmnd.rs/llms.txt",
  Oxlint: "https://oxc.rs/llms.txt",
};

const HOST_ALIASES: Record<string, string[]> = {
  "bun.sh": ["bun.com", "www.bun.com"],
};

const DEFAULT_MAX_RESULTS = 3;
const MAX_RESULTS_LIMIT = 10;
const DEFAULT_MAX_CHUNKS = 3;
const MAX_CHUNKS_LIMIT = 8;
const MAX_CHUNK_CHARS = 1600;
const DEFAULT_HEADING = "Introduction";

const server = new McpServer({
  name: "stella-docs",
  version: "1.2.1",
});

type SourceEntry = {
  name: string;
  indexUrl: string;
};

type SearchResult = {
  source: string;
  title: string;
  url: string;
  score: number;
};

type DocPageEntry = {
  source: string;
  title: string;
  url: string;
  section: string;
  description: string;
  slug: string;
};

type DocChunk = {
  heading: string;
  text: string;
  score: number;
};

server.tool(
  "list_doc_sources",
  "List available library documentation sources",
  () => ({
    content: Object.entries(SOURCES).map(([name, url]) => ({
      type: "text" as const,
      text: `${name}: ${url}`,
    })),
  }),
);

const ALLOWED_HOSTS = new Set(
  Object.values(SOURCES).flatMap((u) => {
    const host = new URL(u).hostname;
    return [host].concat(HOST_ALIASES[host] ?? []);
  }),
);

const normalizeText = (value: string) =>
  value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const GENERIC_TITLE_TERMS = new Set([
  "overview",
  "introduction",
  "getting started",
  "quick start",
  "installation",
  "tutorial",
  "plugin",
  "plugins",
  "documentation",
]);

const tokenize = (value: string) => {
  const matches = value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu);
  if (!matches) {
    return [];
  }

  return [...new Set(matches)];
};

const countMatches = (value: string, term: string) => {
  const matches = value.match(new RegExp(escapeRegExp(term), "giu"));
  return matches?.length ?? 0;
};

type MarkdownLink = {
  title: string;
  rawUrl: string;
  matchedText: string;
};

const parseMarkdownLinks = (line: string) => {
  const links: MarkdownLink[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    const titleStart = line.indexOf("[", cursor);
    if (titleStart === -1) {
      break;
    }

    const titleEnd = line.indexOf("]", titleStart + 1);
    if (titleEnd === -1 || line[titleEnd + 1] !== "(") {
      cursor = titleStart + 1;
      continue;
    }

    const urlStart = titleEnd + 2;
    const urlEnd = line.indexOf(")", urlStart);
    if (urlEnd === -1) {
      break;
    }

    const title = line.slice(titleStart + 1, titleEnd).trim();
    const rawUrl = line.slice(urlStart, urlEnd).trim();
    const matchedText = line.slice(titleStart, urlEnd + 1);

    if (title.length > 0 && rawUrl.length > 0 && !rawUrl.includes(" ")) {
      links.push({ title, rawUrl, matchedText });
    }

    cursor = urlEnd + 1;
  }

  return links;
};

const stripMarkdownFormatting = (value: string) => {
  let text = value;
  for (const { title, matchedText } of parseMarkdownLinks(value)) {
    text = text.replaceAll(matchedText, title);
  }

  return text
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .replace(/_([^_]+)_/gu, "$1");
};

const getUrlSlug = (url: string) => {
  const pathname = new URL(url).pathname
    .replace(/\/+/gu, "/")
    .replace(/\/$/u, "");
  const lastSegment = pathname.split("/").at(-1) ?? pathname;
  return lastSegment.replace(/\.md$/iu, "");
};

const extractInlineDescription = ({
  line,
  matchedText,
}: {
  line: string;
  matchedText: string;
}) => {
  const matchIndex = line.indexOf(matchedText);
  if (matchIndex === -1) {
    return "";
  }

  const trailing = line.slice(matchIndex + matchedText.length).trim();
  if (trailing.startsWith(":")) {
    return trailing.slice(1).trim();
  }

  return trailing.replace(/^[-*]\s+/u, "").trim();
};

const getHeadingPath = (headings: string[]) =>
  headings.filter((heading) => heading.length > 0).join(" > ");

const parseMarkdownHeading = (
  line: string,
  minLevel: number,
  maxLevel: number,
) => {
  let level = 0;
  while (line[level] === "#") {
    level += 1;
  }

  if (
    level < minLevel ||
    level > maxLevel ||
    line[level] !== " " ||
    line.length <= level + 1
  ) {
    return undefined;
  }

  return {
    level,
    text: line.slice(level + 1),
  };
};

const scoreTextField = ({
  value,
  query,
  queryTerms,
  exactWeight,
  termWeight,
}: {
  value: string;
  query: string;
  queryTerms: string[];
  exactWeight: number;
  termWeight: number;
}) => {
  const normalizedValue = value.toLowerCase();
  let score = 0;

  if (query.length > 0 && normalizedValue.includes(query)) {
    score += exactWeight;
  }

  for (const term of queryTerms) {
    score += countMatches(normalizedValue, term) * termWeight;
  }

  return score;
};

const scoreText = ({
  heading,
  body,
  query,
}: {
  heading: string;
  body: string;
  query: string;
}) => {
  const normalizedHeading = heading.toLowerCase();
  const normalizedBody = body.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  const queryTerms = tokenize(query);

  let score = 0;

  if (
    normalizedQuery.length > 0 &&
    (normalizedHeading.includes(normalizedQuery) ||
      normalizedBody.includes(normalizedQuery))
  ) {
    score += 10;
  }

  for (const term of queryTerms) {
    const headingMatches = countMatches(normalizedHeading, term);
    const bodyMatches = countMatches(normalizedBody, term);
    score += headingMatches * 4;
    score += Math.min(bodyMatches, 5);
  }

  return score;
};

const scoreDocEntry = ({
  title,
  section,
  slug,
  description,
  query,
}: {
  title: string;
  section: string;
  slug: string;
  description: string;
  query: string;
}) => {
  const normalizedQuery = query.toLowerCase().trim();
  const queryTerms = tokenize(query);
  const titleScore = scoreTextField({
    value: title,
    query: normalizedQuery,
    queryTerms,
    exactWeight: 30,
    termWeight: 8,
  });
  const sectionScore = scoreTextField({
    value: section,
    query: normalizedQuery,
    queryTerms,
    exactWeight: 10,
    termWeight: 4,
  });
  const slugText = slug.replace(/[-_/]+/gu, " ");
  const slugScore = scoreTextField({
    value: slugText,
    query: normalizedQuery,
    queryTerms,
    exactWeight: 24,
    termWeight: 6,
  });
  const descriptionScore = scoreTextField({
    value: description,
    query: normalizedQuery,
    queryTerms,
    exactWeight: 6,
    termWeight: 2,
  });

  let score = titleScore + sectionScore + slugScore + descriptionScore;
  const titleTokens = new Set(tokenize(title));
  const slugTokens = new Set(tokenize(slug));
  const exactTitle = title.toLowerCase() === normalizedQuery;
  const exactSlug = slugText.toLowerCase() === normalizedQuery;
  const allTermsInTitle =
    queryTerms.length > 0 && queryTerms.every((term) => titleTokens.has(term));
  const allTermsInSlug =
    queryTerms.length > 0 && queryTerms.every((term) => slugTokens.has(term));

  if (exactTitle) {
    score += 40;
  }

  if (exactSlug) {
    score += 35;
  }

  if (allTermsInTitle) {
    score += 20;
  }

  if (allTermsInSlug) {
    score += 12;
  }

  if (GENERIC_TITLE_TERMS.has(title.toLowerCase())) {
    score -= 8;
  }

  return score;
};

const validateSources = (sourceNames?: string[]) => {
  if (!sourceNames || sourceNames.length === 0) {
    return Object.entries(SOURCES).map(([name, indexUrl]) => ({
      name,
      indexUrl,
    }));
  }

  const entries: SourceEntry[] = [];
  for (const sourceName of sourceNames) {
    const indexUrl = SOURCES[sourceName];
    if (!indexUrl) {
      throw new Error(`Unknown doc source: ${sourceName}`);
    }
    entries.push({ name: sourceName, indexUrl });
  }

  return entries;
};

const fetchConfiguredDocUrl = async (url: string) =>
  await fetchAllowedUrl({ allowedHosts: ALLOWED_HOSTS, url });

const isAllowedDocUrl = (url: string) =>
  isAllowedDocUrlForHosts(url, ALLOWED_HOSTS);

const parseIndexEntries = ({
  source,
  indexUrl,
  indexText,
}: {
  source: string;
  indexUrl: string;
  indexText: string;
}) => {
  const entries: DocPageEntry[] = [];
  const seenUrls = new Set<string>();
  const normalizedText = normalizeText(indexText);
  const headingStack: string[] = [];
  let lastParagraph = "";

  for (const line of normalizedText.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      lastParagraph = "";
      continue;
    }

    const headingMatch = parseMarkdownHeading(trimmedLine, 2, 6);
    if (headingMatch) {
      const { level } = headingMatch;
      const heading = stripMarkdownFormatting(
        headingMatch.text.trim() || DEFAULT_HEADING,
      );
      headingStack[level - 2] = heading;
      headingStack.length = level - 1;
      lastParagraph = "";
      continue;
    }

    const markdownLinks = parseMarkdownLinks(trimmedLine);

    if (markdownLinks.length === 0) {
      if (!trimmedLine.startsWith(">")) {
        lastParagraph = stripMarkdownFormatting(trimmedLine);
      }
      continue;
    }

    for (const match of markdownLinks) {
      const { title, rawUrl, matchedText } = match;

      const url = new URL(rawUrl, indexUrl).toString();
      if (!isAllowedDocUrl(url) || seenUrls.has(url)) {
        continue;
      }

      seenUrls.add(url);
      entries.push({
        source,
        title: stripMarkdownFormatting(title),
        url,
        section: getHeadingPath(headingStack),
        description:
          extractInlineDescription({ line: trimmedLine, matchedText }) ||
          lastParagraph,
        slug: getUrlSlug(url),
      });
    }

    lastParagraph = "";
  }

  return entries;
};

const splitIntoChunks = (pageText: string) => {
  const chunks: { heading: string; text: string }[] = [];
  const lines = normalizeText(pageText).split("\n");

  let heading = DEFAULT_HEADING;
  let sectionLines: string[] = [];

  const flushSection = () => {
    const sectionText = sectionLines.join("\n").trim();
    sectionLines = [];

    if (sectionText.length === 0) {
      return;
    }

    let currentChunk = "";
    for (const paragraph of sectionText.split(/\n{2,}/u)) {
      const trimmedParagraph = paragraph.trim();
      if (trimmedParagraph.length === 0) {
        continue;
      }

      const candidate = currentChunk
        ? `${currentChunk}\n\n${trimmedParagraph}`
        : trimmedParagraph;

      if (candidate.length <= MAX_CHUNK_CHARS) {
        currentChunk = candidate;
        continue;
      }

      if (currentChunk.length > 0) {
        chunks.push({ heading, text: currentChunk });
      }

      if (trimmedParagraph.length <= MAX_CHUNK_CHARS) {
        currentChunk = trimmedParagraph;
        continue;
      }

      let start = 0;
      while (start < trimmedParagraph.length) {
        const end = Math.min(start + MAX_CHUNK_CHARS, trimmedParagraph.length);
        chunks.push({
          heading,
          text: trimmedParagraph.slice(start, end).trim(),
        });
        start = end;
      }
      currentChunk = "";
    }

    if (currentChunk.length > 0) {
      chunks.push({ heading, text: currentChunk });
    }
  };

  for (const line of lines) {
    const headingMatch = parseMarkdownHeading(line, 1, 6);
    if (!headingMatch) {
      sectionLines.push(line);
      continue;
    }

    flushSection();
    heading = headingMatch.text.trim() || DEFAULT_HEADING;
  }

  flushSection();

  if (chunks.length > 0) {
    return chunks;
  }

  const fallbackText = normalizeText(pageText).trim();
  if (fallbackText.length === 0) {
    return [];
  }

  return [{ heading: DEFAULT_HEADING, text: fallbackText }];
};

server.tool(
  "fetch_docs",
  "Fetch a llms.txt index or a specific doc page URL",
  { url: z.string().url() },
  async ({ url }) => {
    try {
      return {
        content: [
          { type: "text" as const, text: await fetchConfiguredDocUrl(url) },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to fetch ${url}: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "search_docs",
  "Search configured doc indexes and return only the top matching pages",
  {
    query: z.string().min(2),
    sources: z.array(z.string()).optional(),
    maxResults: z.number().int().min(1).max(MAX_RESULTS_LIMIT).optional(),
  },
  async ({ query, sources, maxResults }) => {
    try {
      const selectedSources = validateSources(sources);
      const results: SearchResult[] = [];
      const settledSources = await Promise.allSettled(
        selectedSources.map(async ({ name, indexUrl }) => ({
          name,
          indexUrl,
          indexText: await fetchConfiguredDocUrl(indexUrl),
        })),
      );

      const successfulSources = settledSources.filter(
        (
          source,
        ): source is PromiseFulfilledResult<{
          indexText: string;
          indexUrl: string;
          name: string;
        }> => source.status === "fulfilled",
      );

      if (successfulSources.length === 0) {
        throw new Error("Could not fetch any selected documentation indexes");
      }

      for (const { value } of successfulSources) {
        const { name, indexText, indexUrl } = value;
        for (const entry of parseIndexEntries({
          source: name,
          indexUrl,
          indexText,
        })) {
          const score = scoreDocEntry({
            title: entry.title,
            section: entry.section,
            slug: entry.slug,
            description: entry.description,
            query,
          });

          if (score <= 0) {
            continue;
          }

          results.push({
            source: entry.source,
            title:
              entry.section.length > 0
                ? `${entry.title} (${entry.section})`
                : entry.title,
            url: entry.url,
            score,
          });
        }
      }

      const limitedResults = results
        .sort((left, right) => right.score - left.score)
        .slice(0, maxResults ?? DEFAULT_MAX_RESULTS);

      if (limitedResults.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matching documentation pages found for "${query}".`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(limitedResults, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to search docs: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "fetch_doc_chunks",
  "Fetch only the most relevant chunks from a doc page for a given query",
  {
    url: z.string().url(),
    query: z.string().min(2),
    maxChunks: z.number().int().min(1).max(MAX_CHUNKS_LIMIT).optional(),
  },
  async ({ url, query, maxChunks }) => {
    try {
      const pageText = await fetchConfiguredDocUrl(url);
      const scoredChunks: DocChunk[] = [];

      for (const chunk of splitIntoChunks(pageText)) {
        const score = scoreText({
          heading: chunk.heading,
          body: chunk.text,
          query,
        });

        if (score <= 0) {
          continue;
        }

        scoredChunks.push({
          heading: chunk.heading,
          text: chunk.text,
          score,
        });
      }

      const limitedChunks = scoredChunks
        .sort((left, right) => right.score - left.score)
        .slice(0, maxChunks ?? DEFAULT_MAX_CHUNKS);

      if (limitedChunks.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No relevant chunks found for "${query}" in ${url}.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              limitedChunks.map((chunk) => ({
                heading: chunk.heading,
                score: chunk.score,
                text: chunk.text,
              })),
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to fetch doc chunks for ${url}: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
