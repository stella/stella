import { useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import { defineChart, rect } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { panic } from "better-result";
import { scaleUtc } from "d3-scale";
import { IntlProvider, useFormatter, useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { ReviewDiffText } from "@stll/ui/review-diff-text";

import { STATUTE_TIMELINE_APP } from "../manifest";
import { createPresentationBridge } from "../shared/bridge";
import { appLocale } from "../shared/locale";
import {
  provisionReadInput,
  compareAdjacentVersions,
  isCurrentVersion,
  mergeHistory,
  timelineWindows,
  versionWording,
} from "./model";
import { parseHistory, parseProvisionRead } from "./parse";
import type { ProvisionHistory, ProvisionVersion } from "./parse";
import "../shared/generated/style.css";

const bridge = createPresentationBridge({
  manifest: STATUTE_TIMELINE_APP,
  parse: parseHistory,
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
  initial: ProvisionHistory;
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
      result?.isError === true
        ? undefined
        : parseHistory(result?.structuredContent);
    if (
      page === undefined ||
      page.eli !== history.eli ||
      page.anchor !== history.anchor
    ) {
      setRead({
        status: "error",
        message:
          result?.content.find((part) => part.type === "text")?.text ?? null,
      });
      return;
    }
    setHistory((current) => mergeHistory(current, page));
    setRead({ status: "idle" });
  };
  const readVersion = async (version: ProvisionVersion) => {
    const argumentsForVersion = provisionReadInput({
      history,
      version,
      ...(typeof input["language"] === "string"
        ? { language: input["language"] }
        : {}),
    });
    if (argumentsForVersion === undefined) {
      return;
    }
    setRead({ status: "loading" });
    const result = await bridge.requestTool({
      name: "read_statute_provisions",
      arguments: argumentsForVersion,
    });
    const response =
      result?.isError === true
        ? undefined
        : parseProvisionRead(result?.structuredContent);
    const wording = response?.items.at(0);
    if (
      wording?.status !== "found" ||
      wording.documentId !== version.documentId ||
      wording.eli !== history.eli ||
      wording.anchor !== history.anchor
    ) {
      setRead({
        status: "error",
        message:
          wording !== undefined && "message" in wording
            ? wording.message
            : null,
      });
      return;
    }
    setHistory((current) => ({
      ...current,
      items: current.items.map((entry) =>
        entry.documentId === version.documentId
          ? {
              appUrl: entry.appUrl,
              url: entry.url,
              ...(entry.source_url === undefined
                ? {}
                : { source_url: entry.source_url }),
              documentId: entry.documentId,
              resourceName: entry.resourceName,
              versionValidFrom: entry.versionValidFrom,
              versionValidTo: entry.versionValidTo,
              expressionKind: entry.expressionKind,
              windowDisposition: entry.windowDisposition,
              windowDispositionBasis: entry.windowDispositionBasis,
              status: "found",
              text: wording.text,
              truncated: wording.truncated,
            }
          : entry,
      ),
    }));
    setRead({ status: "idle" });
  };
  const content = selected === undefined ? null : versionWording(selected);
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
                {(content.type === "withheld" || content.truncated) && (
                  <Button
                    className="h-auto max-w-full whitespace-normal"
                    variant="outline"
                    disabled={
                      !bridge.supportsTools() ||
                      read.status === "loading" ||
                      selected.versionValidFrom === null
                    }
                    onClick={() =>
                      bridge.detached(
                        readVersion(selected),
                        "read provision wording",
                      )
                    }
                  >
                    {t("timelineReadVersion")}
                  </Button>
                )}
              </div>
              {(content.type === "withheld" || content.truncated) &&
                selected.versionValidFrom === null && (
                  <p>{t("timelineNoDate")}</p>
                )}
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
          onClick={() => bridge.detached(loadMore(), "page provision history")}
        >
          {t("timelineLoadMore")}
        </Button>
      )}
    </main>
  );
};

const TimelineChart = ({
  history,
  today,
  onSelect,
}: {
  history: ProvisionHistory;
  today: string;
  onSelect: (documentId: string) => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const definition = useMemo(() => {
    const windows = timelineWindows(history.items, today);
    return defineChart({
      marks: [
        rect(
          windows.rows.filter((row) => !row.current),
          {
            x1: "start",
            x2: "end",
            y: "id",
            key: "id",
            fill: "var(--foreground)",
            fillOpacity: 0.3,
            stroke: "var(--foreground)",
            inset: 6,
          },
        ),
        rect(
          windows.rows.filter((row) => row.current),
          {
            x1: "start",
            x2: "end",
            y: "id",
            key: "id",
            fill: "var(--foreground)",
            fillOpacity: 0.6,
            stroke: "var(--foreground)",
            strokeWidth: 2,
            inset: 6,
          },
        ),
      ],
      scales: {
        x: {
          scale: scaleUtc().domain([...windows.domain]),
          axis: {
            ticks: {
              count: 4,
              format: (value) =>
                format.dateTime(value, {
                  year: "numeric",
                  month: "short",
                  timeZone: "UTC",
                }),
            },
          },
        },
        y: {
          scale: scaleBand().domain(windows.rows.map((row) => row.id)),
          axis: false,
        },
      },
      theme: {
        foreground: "var(--foreground)",
        muted: "var(--muted-foreground)",
        background: "var(--background)",
        grid: "var(--border)",
      },
      keyboard: true,
    });
  }, [history.items, today, format]);
  return (
    <div
      data-testid="statute-timeline-chart"
      className="min-w-0 max-[480px]:hidden"
    >
      <Chart
        definition={definition}
        height={Math.max(140, history.items.length * 36 + 48)}
        initialWidth={640}
        ariaLabel={t("timelineTitle")}
        onSelect={(point) => {
          if (point !== null) {
            onSelect(point.datum.id);
          }
        }}
      />
    </div>
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
                <p>{result.message ?? locale.messages.error}</p>
                <Button
                  onClick={() =>
                    bridge.detached(bridge.retry(), "retry provision history")
                  }
                >
                  {locale.messages.retry}
                </Button>
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
bridge.detached(bridge.connect(), "connect statute timeline");
