import { useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import { panic } from "better-result";
import { IntlProvider, useFormatter, useTranslations } from "use-intl";

import { parseLegalCitationHttpUrl } from "@stll/api-contract/legal-citation-links";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { containedEventHandler } from "@stll/ui/use-contained-handler";
import { cn } from "@stll/ui/utils";

import { CITATION_GRAPH_APP } from "../manifest";
import { createPresentationBridge } from "../shared/bridge";
import { appLocale } from "../shared/locale";
import { createGraphController } from "./controller";
import {
  canExpand,
  EXPANSION_LIMIT,
  graphElements,
  layoutGraph,
  POLARITY_DASH,
} from "./model";
import type { GraphModel, GraphNode } from "./model";
import { parseCitationPage } from "./parse";
import "../shared/generated/style.css";

const bridge = createPresentationBridge({
  manifest: CITATION_GRAPH_APP,
  parse: parseCitationPage,
});
const controller = createGraphController(bridge);
const nodeLabel = (node: GraphNode, t: ReturnType<typeof useTranslations>) => {
  switch (node.type) {
    case "subject":
      return t("subjectDecision");
    case "resolved":
      return node.decision.caseNumber;
    case "unresolved":
      return node.citationText ?? t("unresolvedCitation");
    default:
      return panic("Unknown citation node", node satisfies never);
  }
};

const Graph = ({ model, busy }: { model: GraphModel; busy: boolean }) => {
  const t = useTranslations();
  const layout = useMemo(() => layoutGraph(model), [model]);
  const [selected, setSelected] = useState<string | null>(null);
  const positions = new Map(layout.nodes.map((node) => [node.id, node]));
  return (
    <div className="hidden min-[600px]:block">
      <svg
        data-testid="citation-graph"
        viewBox="0 0 800 480"
        className="w-full"
        role="group"
        aria-label={t("graphTitle")}
      >
        <defs>
          <marker
            id="citation-arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {layout.edges.map((edge) => {
          const source =
            positions.get(edge.source) ?? panic("Citation edge has no source");
          const target =
            positions.get(edge.target) ?? panic("Citation edge has no target");
          const distance = Math.hypot(target.x - source.x, target.y - source.y);
          const ratio =
            distance === 0 ? 0 : Math.max(0, distance - 35) / distance;
          return (
            <line
              key={edge.id}
              data-edge-id={edge.id}
              data-polarity={edge.polarity}
              x1={source.x}
              y1={source.y}
              x2={source.x + (target.x - source.x) * ratio}
              y2={source.y + (target.y - source.y) * ratio}
              stroke="currentColor"
              strokeWidth={
                selected === source.id || selected === target.id ? 3 : 1.5
              }
              strokeDasharray={POLARITY_DASH[edge.polarity]}
              markerEnd="url(#citation-arrow)"
            >
              <title>
                {t(edge.direction)}: {t(edge.polarity)}
              </title>
            </line>
          );
        })}
        {layout.nodes.map((node) => (
          <g key={node.id}>
            {node.type === "unresolved" ? (
              <rect
                x={node.x - 26}
                y={node.y - 26}
                width="52"
                height="52"
                rx="6"
                fill="var(--muted)"
                stroke="currentColor"
                strokeDasharray="4 3"
              />
            ) : (
              <circle
                cx={node.x}
                cy={node.y}
                r={node.type === "subject" ? 30 : 26}
                fill="var(--background)"
                stroke="currentColor"
                strokeWidth={node.type === "subject" ? 3 : 1}
              />
            )}
            <foreignObject
              x={node.x - 80}
              y={node.y - 22}
              width="160"
              height="44"
            >
              <button
                type="button"
                data-node-id={node.id}
                disabled={
                  node.type === "resolved" &&
                  (busy ||
                    (!bridge.supportsTools() &&
                      parseLegalCitationHttpUrl(node.decision.url) === null))
                }
                className="bg-background h-11 w-full truncate rounded-md px-2 text-xs focus-visible:outline-2"
                title={nodeLabel(node, t)}
                onFocus={() => setSelected(node.id)}
                onClick={containedEventHandler(() => {
                  setSelected(node.id);
                  if (node.type === "resolved") {
                    bridge.detached(
                      controller.open(node.id, node.decision.url),
                      "citationGraph.openDecision",
                    );
                  }
                })}
              >
                <bdi>{nodeLabel(node, t)}</bdi>
              </button>
            </foreignObject>
          </g>
        ))}
      </svg>
      <ul
        className="flex flex-wrap gap-x-4 gap-y-2 text-xs"
        aria-label={t("graphTitle")}
      >
        {Object.entries(POLARITY_DASH).map(([polarity, dash]) => (
          <li key={polarity} className="flex items-center gap-2">
            <svg width="36" height="12" aria-hidden="true">
              <line
                x1="0"
                y1="6"
                x2="36"
                y2="6"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={dash}
              />
            </svg>
            {t(polarity)}
          </li>
        ))}
      </ul>
    </div>
  );
};

const CitationList = ({
  model,
  busy,
}: {
  model: GraphModel;
  busy: boolean;
}) => {
  const t = useTranslations();
  const { nodes, edges } = graphElements(model);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return (
    <div data-testid="citation-list" className="space-y-3">
      {edges.length === 0 && <p>{t("noResults")}</p>}
      {edges.map((edge) => {
        const targetId = edge.direction === "cites" ? edge.target : edge.source;
        const node = byId.get(targetId) ?? panic("Citation list has no node");
        const decision = edge.decision;
        const url =
          decision !== null
            ? (parseLegalCitationHttpUrl(decision.url)?.href ?? null)
            : null;
        return (
          <article
            data-citation-id={edge.id}
            key={edge.id}
            className="space-y-2 rounded-lg border p-3"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {decision !== null ? (
                <Button
                  variant="link"
                  className="max-w-full min-w-0 shrink"
                  disabled={busy || (!bridge.supportsTools() && url === null)}
                  onClick={containedEventHandler(() =>
                    bridge.detached(
                      controller.open(decision.decisionId, url),
                      "citationGraph.openDecision",
                    ),
                  )}
                >
                  <BidiText className="min-w-0 truncate">
                    {decision.caseNumber}
                  </BidiText>
                </Button>
              ) : (
                <p className="min-w-0 font-medium break-words">
                  {nodeLabel(node, t)}
                </p>
              )}
              {node.type === "unresolved" && (
                <span className="text-muted-foreground text-xs">
                  {t("unresolvedCitation")}
                </span>
              )}
              <span
                data-polarity={edge.polarity}
                className="text-muted-foreground text-xs"
              >
                {t(edge.direction)} · {t(edge.polarity)}
              </span>
            </div>
            <p dir="ltr" className="text-muted-foreground text-xs break-all">
              <bdi>{edge.source}</bdi> → <bdi>{edge.target}</bdi>
            </p>
            {edge.textWithheldReason !== null ? (
              <p>
                {t(edge.textWithheldReason)}{" "}
                <code>{edge.textWithheldReason}</code>
              </p>
            ) : (
              edge.passage !== null && (
                <blockquote className="text-sm break-words">
                  {edge.passage.text}
                  {edge.passage.truncated && "…"}
                </blockquote>
              )
            )}
            {decision !== null && (
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !bridge.supportsTools() ||
                  !canExpand(model, decision.decisionId)
                }
                aria-label={`${t("expandNode")}: ${decision.caseNumber}`}
                onClick={containedEventHandler(() =>
                  bridge.detached(
                    controller.read(decision.decisionId),
                    "citationGraph.expandNode",
                  ),
                )}
              >
                {t("expandNode")}
              </Button>
            )}
          </article>
        );
      })}
    </div>
  );
};

const App = () => {
  const t = useTranslations();
  const format = useFormatter();
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const host = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const [view, setView] = useState<"graph" | "list">("graph");
  const { model, request } = state;
  if (model === null) {
    return (
      <main className="p-4">
        <p role={host.result.status === "error" ? "alert" : "status"}>
          {t(host.result.status === "error" ? "error" : "loading")}
        </p>
        {host.result.status === "error" && (
          <Button
            onClick={containedEventHandler(() =>
              bridge.detached(bridge.retry(), "citationGraph.retry"),
            )}
          >
            {t("retry")}
          </Button>
        )}
      </main>
    );
  }
  return (
    <main className="space-y-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t("graphTitle")}</h1>
        <div className="hidden gap-2 min-[600px]:flex">
          <Button
            variant="outline"
            aria-pressed={view === "graph"}
            onClick={() => setView("graph")}
          >
            {t("graphView")}
          </Button>
          <Button
            variant="outline"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            {t("listView")}
          </Button>
        </div>
      </header>
      <p className="text-sm break-all">
        {t("subjectDecision")}: <bdi>{model.subjectId}</bdi>
      </p>
      <p role="status" className="text-muted-foreground text-xs">
        {t("expandedNodes", {
          count: format.number(model.expanded.length),
          limit: format.number(EXPANSION_LIMIT),
        })}
        . {t("expansionLimit", { count: format.number(EXPANSION_LIMIT) })}
      </p>
      {request.status === "error" && (
        <p role="alert">{request.message ?? t("error")}</p>
      )}
      {request.status === "loading" && <p role="status">{t("loading")}</p>}
      {view === "graph" && (
        <Graph model={model} busy={request.status === "loading"} />
      )}
      <div className={cn(view === "graph" && "min-[600px]:mt-4")}>
        <CitationList model={model} busy={request.status === "loading"} />
      </div>
      <div className="flex flex-wrap gap-2">
        {model.pages
          .filter(({ nextCursor }) => nextCursor !== null)
          .map((page) => (
            <Button
              key={page.decisionId}
              variant="outline"
              disabled={request.status === "loading" || !bridge.supportsTools()}
              aria-label={`${t("loadMore")}: ${page.decisionId}`}
              onClick={containedEventHandler(() =>
                bridge.detached(
                  controller.read(page.decisionId),
                  "citationGraph.loadPage",
                ),
              )}
            >
              {t("loadMore")}
            </Button>
          ))}
      </div>
    </main>
  );
};

const LocalizedApp = () => {
  const { context } = useSyncExternalStore(
    bridge.subscribe,
    bridge.getSnapshot,
  );
  const locale = appLocale(context.locale);
  return (
    <IntlProvider locale={locale.formattingLocale} messages={locale.messages}>
      <DirectionProvider direction={locale.direction}>
        <App />
      </DirectionProvider>
    </IntlProvider>
  );
};
const root = document.querySelector("#app");
if (root !== null) {
  createRoot(root).render(<LocalizedApp />);
}
bridge.detached(bridge.connect(), "citationGraph.connect");
