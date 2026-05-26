import { useState } from "react";

import { ExternalLinkIcon, GlobeIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import type { ChatMessage, ChatPart } from "@/components/chat/chat-ui-tools";
import { sanitizeHref } from "@/lib/sanitize-href";

const SourceFavicon = ({ hostname }: { hostname: string }) => {
  const [errored, setErrored] = useState(false);
  if (errored || !hostname) {
    return <GlobeIcon className="text-muted-foreground size-3 shrink-0" />;
  }
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn(
        "border-border size-3 shrink-0 rounded-full border object-contain",
      )}
      loading="lazy"
      onError={() => setErrored(true)}
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`}
    />
  );
};

const WEB_SEARCH_PART_TYPE = "tool-web_search";
const FETCH_URL_PART_TYPE = "tool-fetch_url";

type WebSource = {
  url: string;
  title: string;
  source: string;
  snippet: string | undefined;
  publishedAt: string | undefined;
};

const extractHostname = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
};

type WebSearchCollected = {
  sources: WebSource[];
  answers: string[];
};

const collectFromPart = (
  part: ChatPart,
  sink: Map<string, WebSource>,
  answers: string[],
): void => {
  if (part.type === WEB_SEARCH_PART_TYPE && part.state === "output-available") {
    if (part.output.answer) {
      answers.push(part.output.answer);
    }
    for (const result of part.output.results) {
      if (sink.has(result.url)) {
        continue;
      }
      sink.set(result.url, {
        url: result.url,
        title: result.title,
        source: result.source,
        snippet: result.snippet,
        publishedAt: result.publishedAt,
      });
    }
    return;
  }
  if (part.type === FETCH_URL_PART_TYPE && part.state === "output-available") {
    const output = part.output;
    if (sink.has(output.url)) {
      return;
    }
    sink.set(output.url, {
      url: output.url,
      title: output.title ?? output.url,
      source: extractHostname(output.url),
      snippet: undefined,
      publishedAt: output.publishedAt,
    });
  }
};

const collectMessageWebSources = (
  parts: ChatMessage["parts"],
): WebSearchCollected => {
  const byUrl = new Map<string, WebSource>();
  const answers: string[] = [];
  for (const part of parts) {
    collectFromPart(part, byUrl, answers);
  }
  return { sources: [...byUrl.values()], answers };
};

type WebSearchSourcesProps = {
  parts: ChatMessage["parts"];
};

export const WebSearchSources = ({ parts }: WebSearchSourcesProps) => {
  const t = useTranslations();
  const { sources, answers } = collectMessageWebSources(parts);
  if (sources.length === 0 && answers.length === 0) {
    return null;
  }
  return (
    <div className="mt-3 space-y-2.5">
      {answers.length > 0 && (
        <div className="bg-muted/30 space-y-1 rounded-md border p-2.5">
          <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            {t("chat.webSearch.answer")}
          </div>
          {answers.map((answer, index) => (
            <p
              className="text-foreground text-sm leading-relaxed whitespace-pre-line"
              key={`${index}-${answer.slice(0, 16)}`}
            >
              {answer}
            </p>
          ))}
          <p className="text-muted-foreground text-[11px] italic">
            {t("chat.webSearch.answerDisclaimer")}
          </p>
        </div>
      )}
      {sources.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            {t("chat.webSearch.sources")}
          </div>
          <ol className="flex flex-wrap gap-1.5">
            {sources.map((source, index) => {
              const href = sanitizeHref(source.url);
              if (!href) {
                return null;
              }
              return (
                <li key={source.url}>
                  <a
                    aria-label={t("chat.webSearch.openSource", {
                      source: source.source,
                    })}
                    className="bg-muted/30 hover:bg-muted/60 focus-visible:ring-ring/50 group inline-flex max-w-xs items-center gap-1.5 rounded-md border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:outline-none"
                    href={href}
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                    title={source.snippet ?? source.title}
                  >
                    <span className="text-muted-foreground tabular-nums">
                      {index + 1}.
                    </span>
                    <SourceFavicon hostname={source.source} />
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{source.title}</span>
                      <span className="text-muted-foreground ms-1.5">
                        {source.source}
                      </span>
                    </span>
                    <ExternalLinkIcon className="text-muted-foreground size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
};
