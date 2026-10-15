import { lazy, Suspense } from "react";

import { useTranslations } from "use-intl";

import {
  githubArchiveUrl,
  type LoadedCatalogueEntry,
  type LoadedEntryByKind,
} from "@stll/catalogue";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Button } from "@stll/ui/button";

import {
  buildMcpConfigSnippet,
  githubSkillTreeUrl,
} from "@/features/knowledge/public/tools/tool-detail.logic";
import { publicToolDownloadPath } from "@/lib/knowledge/public-tools-path";

const ToolMarkdown = lazy(async () => ({
  default: (await import("@/features/knowledge/public/tools/tool-markdown"))
    .ToolMarkdown,
}));

const CopyButton = lazy(async () => ({
  default: (await import("@/features/knowledge/public/tools/copy-button"))
    .CopyButton,
}));

/** The install button's place while it cannot act yet. */
export const InstallButtonPlaceholder = () => {
  const t = useTranslations();
  return (
    <Button disabled type="button">
      {t("publicTools.addToStella")}
    </Button>
  );
};

export const DownloadAffordance = ({
  entry,
}: {
  entry: LoadedCatalogueEntry;
}) => {
  const t = useTranslations();
  if (entry.kind !== "skill") {
    return null;
  }
  if (entry.source === "in-tree") {
    return (
      <Button
        render={
          <a
            aria-label={t("common.download")}
            href={sanitizeHref(publicToolDownloadPath(entry.slug))}
          />
        }
        variant="outline"
      >
        {t("common.download")}
      </Button>
    );
  }
  return (
    <Button
      render={
        <a
          aria-label={t("publicTools.downloadUpstream")}
          href={sanitizeHref(githubArchiveUrl(entry))}
          rel="noreferrer"
          target="_blank"
        />
      }
      variant="outline"
    >
      {t("publicTools.downloadUpstream")}
    </Button>
  );
};

/** A tool's long-form content: its documentation, or how to connect it. */
export const ToolContent = ({
  entry,
  markdown,
}: {
  entry: LoadedCatalogueEntry;
  markdown: string | null;
}) => {
  const t = useTranslations();

  if (entry.kind === "mcp") {
    return <McpConfig entry={entry} />;
  }

  if (entry.kind === "native-tool") {
    return (
      <p className="text-muted-foreground text-sm">
        {t("publicTools.nativeToolInfo")}
      </p>
    );
  }

  if (markdown !== null) {
    return (
      <Suspense fallback={<ContentLoading />}>
        <ToolMarkdown markdown={markdown} />
      </Suspense>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">
        {t("publicTools.contentUnavailable")}
      </p>
      {entry.source === "github" && (
        <a
          className="text-primary text-sm hover:underline"
          href={sanitizeHref(githubSkillTreeUrl(entry))}
          rel="noreferrer"
          target="_blank"
        >
          {t("publicTools.viewOnGithub")}
        </a>
      )}
    </div>
  );
};

const McpConfig = ({ entry }: { entry: LoadedEntryByKind<"mcp"> }) => {
  const t = useTranslations();
  const snippet = buildMcpConfigSnippet({
    slug: entry.slug,
    url: entry.url,
    authType: entry.authType,
    oauthRequestedScopes: entry.oauthRequestedScopes,
  });

  return (
    <section
      aria-label={t("catalogue.configuration")}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {t("catalogue.configuration")}
        </h2>
        <Suspense fallback={null}>
          <CopyButton text={snippet} />
        </Suspense>
      </div>
      <p className="text-muted-foreground text-xs">
        {t("publicTools.mcpConfigHint")}
      </p>
      <pre className="bg-muted/40 border-border overflow-x-auto rounded-md border p-3 font-mono text-xs">
        <bdi>{snippet}</bdi>
      </pre>
      <div className="flex flex-wrap gap-3">
        {entry.documentationUrl && (
          <a
            className="text-primary text-sm hover:underline"
            href={sanitizeHref(entry.documentationUrl)}
            rel="noreferrer"
            target="_blank"
          >
            {t("publicTools.documentation")}
          </a>
        )}
        {entry.tokenHelpUrl && (
          <a
            className="text-primary text-sm hover:underline"
            href={sanitizeHref(entry.tokenHelpUrl)}
            rel="noreferrer"
            target="_blank"
          >
            {t("publicTools.tokenHelp")}
          </a>
        )}
      </div>
    </section>
  );
};

const ContentLoading = () => {
  const t = useTranslations();
  return (
    <p className="text-muted-foreground text-sm">{t("publicTools.content")}</p>
  );
};
