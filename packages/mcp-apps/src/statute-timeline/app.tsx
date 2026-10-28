import { useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import { panic } from "better-result";
import { IntlProvider, useFormatter, useTranslations } from "use-intl";

import { parseLegalCitationHttpUrl } from "@stll/api-contract/legal-citation-links";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { ReviewDiffText } from "@stll/ui/review-diff-text";

import { STATUTE_TIMELINE_APP } from "../manifest";
import { createPresentationBridge } from "../shared/bridge";
import { appLocale } from "../shared/locale";
import {
  compareAdjacentVersions,
  isCurrentVersion,
  mergeHistory,
  versionWording,
} from "./model";
import { parseStatuteTimelineHistory } from "./parse";
import type { ProvisionVersion, StatuteTimelineHistory } from "./parse";
import { TimelineChart, VersionLabel } from "./presentation";
import "../shared/generated/style.css";

const bridge = createPresentationBridge({
  manifest: STATUTE_TIMELINE_APP,
  parse: parseStatuteTimelineHistory,
  title: (context) => appLocale(context.locale).messages.timelineTitle,
});
type ReadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string | null };

const Timeline = ({
  initial,
  input,
}: {
  initial: StatuteTimelineHistory;
  input: Record<string, unknown>;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const [history, setHistory] = useState(initial);
  const [selectedId, setSelectedId] = useState(
    initial.items.at(0)?.documentId ?? null,
  );
  const [mode, setMode] = useState<"wording" | "comparison">("wording");
  const [read, setRead] = useState<ReadState>({ status: "idle" });
  const [today] = useState(() => Temporal.Now.plainDateISO("UTC").toString());
  const selected = history.items.find((item) => item.documentId === selectedId);
  const next =
    selectedId === null
      ? undefined
      : history.items.at(
          history.items.findIndex((item) => item.documentId === selectedId) + 1,
        );
  const canCompare = selected?.status === "found" && next?.status === "found";
  const comparison = useMemo(
    () =>
      mode === "comparison" && selectedId !== null
        ? compareAdjacentVersions(history.items, selectedId)
        : null,
    [mode, selectedId, history.items],
  );
  const windowLabel = (version: ProvisionVersion) => {
    const date = (value: string) =>
      format.dateTime(new Date(value), {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    return `${version.versionValidFrom === null ? t("timelineOpenStart") : date(version.versionValidFrom)} – ${version.versionValidTo === null ? t("timelineOpenEnd") : date(version.versionValidTo)}`;
  };
  const select = (documentId: string) => {
    setSelectedId(documentId);
    setMode("wording");
  };
  const loadMore = async () => {
    if (history.nextCursor === null) {
      return;
    }
    setRead({ status: "loading" });
    const result = await bridge.requestTool({
      name: "read_provision_history",
      arguments: {
        ...input,
        eli: history.eli,
        anchor: history.anchor,
        cursor: history.nextCursor,
      },
    });
    const page =
      result.isError === true
        ? undefined
        : parseStatuteTimelineHistory(result.structuredContent);
    if (
      page === undefined ||
      page.eli !== history.eli ||
      page.anchor !== history.anchor
    ) {
      setRead({
        status: "error",
        message:
          result.content.find((part) => part.type === "text")?.text ?? null,
      });
      return;
    }
    setHistory((current) => mergeHistory(current, page));
    setRead({ status: "idle" });
  };
  const content = selected === undefined ? null : versionWording(selected);
  const selectedUrl =
    selected === undefined ? null : parseLegalCitationHttpUrl(selected.url);
  return (
    <main className="min-w-0 space-y-4 p-4">
      <h1 className="text-lg font-semibold">{t("timelineTitle")}</h1>
      <p className="text-muted-foreground break-words">
        <bdi>{history.anchor}</bdi>
      </p>
      {history.items.length === 0 ? (
        <p>{t("timelineEmpty")}</p>
      ) : (
        <>
          <TimelineChart history={history} today={today} onSelect={select} />
          <ul aria-label={t("timelineTitle")} className="space-y-2">
            {history.items.map((version) => (
              <li key={version.documentId}>
                <Button
                  data-version-id={version.documentId}
                  variant={
                    selectedId === version.documentId ? "secondary" : "outline"
                  }
                  aria-pressed={selectedId === version.documentId}
                  className="h-auto max-w-full flex-wrap text-start whitespace-normal"
                  onClick={() => select(version.documentId)}
                >
                  <span>{windowLabel(version)}</span>
                  <VersionLabel version={version} />
                  {isCurrentVersion(version, today) && (
                    <span className="text-muted-foreground text-xs">
                      {t("timelineCurrent")}
                    </span>
                  )}
                </Button>
              </li>
            ))}
          </ul>
          {selected !== undefined && content !== null && (
            <section aria-live="polite" className="space-y-3">
              <h2 className="font-medium">{windowLabel(selected)}</h2>
              <VersionLabel version={selected} />
              <div className="flex flex-wrap gap-2">
                <Button
                  className="h-auto max-w-full whitespace-normal"
                  variant="outline"
                  disabled={!canCompare}
                  aria-pressed={mode === "comparison"}
                  onClick={() =>
                    setMode(mode === "comparison" ? "wording" : "comparison")
                  }
                >
                  {t("timelineCompare")}
                </Button>
                {(content.type === "withheld" || content.truncated) &&
                  selectedUrl !== null && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        bridge.detached(
                          bridge.openLink(selectedUrl.href, (message) =>
                            setRead({ status: "error", message }),
                          ),
                          "statuteTimeline.openProvisionVersion",
                        )
                      }
                    >
                      {t("timelineOpenVersion")}
                    </Button>
                  )}
              </div>
              <VersionContent version={selected} comparison={comparison} />
            </section>
          )}
        </>
      )}
      {read.status === "error" && (
        <p role="alert">{read.message ?? t("error")}</p>
      )}
      {read.status === "loading" && <p role="status">{t("loading")}</p>}
      {history.nextCursor !== null && (
        <Button
          className="h-auto max-w-full whitespace-normal"
          variant="outline"
          disabled={!bridge.supportsTools() || read.status === "loading"}
          onClick={() =>
            bridge.detached(loadMore(), "statuteTimeline.loadMore")
          }
        >
          {t("timelineLoadMore")}
        </Button>
      )}
    </main>
  );
};

const VersionContent = ({
  version,
  comparison,
}: {
  version: ProvisionVersion;
  comparison: ReturnType<typeof compareAdjacentVersions>;
}) => {
  const t = useTranslations();
  if (comparison !== null) {
    return (
      <>
        {comparison.truncated && (
          <p className="text-muted-foreground">{t("timelinePartialDiff")}</p>
        )}
        <div dir="auto" className="break-words whitespace-pre-wrap">
          <ReviewDiffText segments={comparison.segments} />
        </div>
      </>
    );
  }
  const content = versionWording(version);
  switch (content.type) {
    case "withheld":
      return <p>{content.message}</p>;
    case "wording":
      return (
        <>
          {content.truncated && (
            <p className="text-muted-foreground">{t("timelineTruncated")}</p>
          )}
          <p
            dir="auto"
            data-testid="version-wording"
            className="break-words whitespace-pre-wrap"
          >
            {content.text}
          </p>
        </>
      );
    default:
      return panic("Unknown version content", content satisfies never);
  }
};

const App = () => {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const locale = appLocale(snapshot.context.locale);
  const result = snapshot.result;
  return (
    <DirectionProvider direction={locale.direction}>
      <IntlProvider locale={locale.formattingLocale} messages={locale.messages}>
        {result.status === "ready" ? (
          <Timeline
            key={JSON.stringify(result.view)}
            initial={result.view}
            input={snapshot.input}
          />
        ) : (
          <div
            className="p-4"
            role={result.status === "error" ? "alert" : "status"}
          >
            {result.status === "error" ? (
              <>
                <p>{result.message}</p>
                {result.failure.retryable && (
                  <Button
                    onClick={() =>
                      bridge.detached(bridge.retry(), "statuteTimeline.retry")
                    }
                  >
                    {locale.messages.retry}
                  </Button>
                )}
              </>
            ) : (
              locale.messages.loading
            )}
          </div>
        )}
      </IntlProvider>
    </DirectionProvider>
  );
};
const root =
  document.querySelector("#app") ?? panic("Statute timeline mount is missing");
createRoot(root).render(<App />);
bridge.detached(bridge.connect(), "statuteTimeline.connect");
