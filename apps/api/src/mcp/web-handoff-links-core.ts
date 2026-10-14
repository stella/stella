import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic, Result } from "better-result";

const URL_PATTERN = /https?:\/\/[^\s<>"'`\\]+/gu;

const mapProseLinks = (text: string, transform: (url: string) => string) =>
  text.replace(URL_PATTERN, (match) => {
    let end = match.length;
    while (end > 0 && "),.;]}".includes(match.charAt(end - 1))) {
      end -= 1;
    }
    const url = match.slice(0, end);
    return `${transform(url)}${match.slice(url.length)}`;
  });

const mapStrings = (
  value: unknown,
  transform: (value: string) => string,
  key = "",
): unknown => {
  if (typeof value === "string") {
    if (/(?:url|uri|href)$/iu.test(key)) {
      return transform(value);
    }
    return key === "nextStep" || key === "hint"
      ? mapProseLinks(value, transform)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => mapStrings(item, transform, key));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nested]) => [
        nestedKey,
        mapStrings(nested, transform, nestedKey),
      ]),
    );
  }
  return value;
};
const mapText = (text: string, transform: (value: string) => string) => {
  const parsed = Result.try((): unknown => JSON.parse(text));
  if (Result.isOk(parsed)) {
    return JSON.stringify(mapStrings(parsed.value, transform));
  }
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const labelStart = text.indexOf("[", cursor);
    const labelEnd = text.indexOf("]", labelStart + 1);
    if (labelStart === -1 || labelEnd === -1) {
      break;
    }
    if (text[labelEnd + 1] !== "(") {
      parts.push(text.slice(cursor, labelEnd + 1));
      cursor = labelEnd + 1;
      continue;
    }
    const urlStart = labelEnd + 2;
    const urlEnd = text.indexOf(")", urlStart);
    if (urlEnd === -1) {
      break;
    }
    const url = text.slice(urlStart, urlEnd);
    parts.push(text.slice(cursor, urlStart));
    parts.push(url.length > 0 && !/\s/u.test(url) ? transform(url) : url);
    parts.push(")");
    cursor = urlEnd + 1;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
};

export const webHandoffPaths = (
  value: unknown,
  appBaseUrl: string,
): Map<string, string> => {
  const origin = new URL(appBaseUrl).origin;
  const links = new Map<string, string>();
  const collect = (url: string) => {
    const parsed = URL.parse(url);
    if (parsed?.origin === origin && !parsed.username && !parsed.password) {
      links.set(url, `${parsed.pathname}${parsed.search}`);
    }
    return url;
  };
  mapStrings(value, collect);
  if (
    value !== null &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray(value.content)
  ) {
    const blocks: readonly unknown[] = value.content;
    for (const block of blocks) {
      if (
        block !== null &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        mapText(block.text, collect);
      }
    }
  }
  return links;
};

export const decorateWebHandoffLinks = (
  value: CallToolResult,
  links: ReadonlyMap<string, string>,
  code: string,
): CallToolResult => {
  const replace = (url: string) => {
    if (!links.has(url)) {
      return url;
    }
    const parsed = new URL(url);
    const fragment = parsed.hash
      .slice(1)
      .split("&")
      .filter(
        (part) => part.length > 0 && !new URLSearchParams(part).has("sh"),
      );
    fragment.push(`sh=${code}`);
    parsed.hash = fragment.join("&");
    return parsed.href;
  };
  const record = (recordValue: object) =>
    Object.fromEntries(
      Object.entries(recordValue).map(([key, nested]) => [
        key,
        mapStrings(nested, replace, key),
      ]),
    );
  return {
    ...value,
    content: value.content.map((block) => {
      switch (block.type) {
        case "text":
          return { ...block, text: mapText(block.text, replace) };
        case "resource_link":
          return { ...block, uri: replace(block.uri) };
        case "resource":
          return {
            ...block,
            resource: {
              ...block.resource,
              uri: replace(block.resource.uri),
              ...("text" in block.resource
                ? { text: mapText(block.resource.text, replace) }
                : {}),
            },
          };
        case "image":
        case "audio":
          return block;
        default:
          return panic("Unexpected MCP content block", { block });
      }
    }),
    ...(value.structuredContent === undefined ||
    value.structuredContent === null ||
    typeof value.structuredContent !== "object"
      ? {}
      : { structuredContent: record(value.structuredContent) }),
    ...(value._meta === undefined ? {} : { _meta: record(value._meta) }),
  };
};

type HandoffLinkResultOptions = {
  result: CallToolResult;
  appBaseUrl: string;
  mint: (paths: readonly string[]) => Promise<string | null>;
};
export const handoffLinkResult = async ({
  result,
  appBaseUrl,
  mint,
}: HandoffLinkResultOptions): Promise<CallToolResult> => {
  const links = webHandoffPaths(result, appBaseUrl);
  if (links.size === 0) {
    return result;
  }
  const code = await mint([...new Set(links.values())]);
  return code === null ? result : decorateWebHandoffLinks(result, links, code);
};
