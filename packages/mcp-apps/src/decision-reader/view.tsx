import { useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import { createFormatter } from "use-intl";

import { parseLegalCitationHttpUrl } from "@stll/api-contract/legal-citation-links";
import { DecisionIdentity } from "@stll/decision-reader/decision-identity";
import { BlockRenderer } from "@stll/decision-reader/document-ast-text";
import type { TextAnchor } from "@stll/decision-reader/document-ast-text";
import { ReaderPresentationProvider } from "@stll/decision-reader/reader-adapters";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { TooltipProvider } from "@stll/ui/tooltip";
import { containedEventHandler } from "@stll/ui/use-contained-handler";

import type { ProvisionPreview } from "../shared/generated/contracts";
import { appLocale } from "../shared/locale";
import "../shared/generated/style.css";
import type { ReaderController } from "./controller";
import { openDecisionAnchor, openProvisionAnchor } from "./link-actions";
import { readerMessages } from "./messages";
import { resolveReaderRange } from "./model";
import type { ReaderPager, OpenDecision } from "./model";

const focusReaderBack = (button: HTMLButtonElement | null) => {
  button?.focus({ preventScroll: true });
};

const anchorsFor = (document: ReaderPager, host: ReaderController) => {
  const anchors = new Map<string, TextAnchor[]>();
  const add = (pieceId: string, anchor: TextAnchor) => {
    let existing = anchors.get(pieceId);
    if (existing === undefined) {
      existing = [];
      anchors.set(pieceId, existing);
    }
    if (
      existing.some(
        (span) => span.start < anchor.end && anchor.start < span.end,
      )
    ) {
      return;
    }
    existing.push(anchor);
  };
  const linkHost = {
    supportsTools: host.bridge.supportsTools,
    openLink: host.bridge.openLink,
    openDecision: async (decisionId: string) =>
      host.bridge.call({
        name: "open_case_law_decision",
        arguments: { decision_id: decisionId },
      }),
    previewProvision: host.loadPreview,
  };
  for (const anchor of document.citationAnchors) {
    add(anchor.pieceId, {
      key: anchor.citationId,
      start: anchor.start,
      end: anchor.end,
      render: (children: ReactNode): ReactNode =>
        !host.bridge.supportsTools() && anchor.appUrl === null ? (
          children
        ) : (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() =>
              host.bridge.detached(
                openDecisionAnchor(anchor, linkHost),
                "open cited decision",
              )
            }
          >
            {children}
          </button>
        ),
    });
  }
  for (const anchor of document.provisionAnchors) {
    add(anchor.pieceId, {
      key: `${anchor.provision.document_id}:${anchor.provision.anchor}:${anchor.start}`,
      start: anchor.start,
      end: anchor.end,
      render: (children: ReactNode): ReactNode =>
        !host.bridge.supportsTools() && anchor.appUrl === null ? (
          children
        ) : (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() =>
              host.bridge.detached(
                openProvisionAnchor(anchor, linkHost),
                "preview cited provision",
              )
            }
          >
            {children}
          </button>
        ),
    });
  }
  return Object.fromEntries(anchors);
};

const McpDecisionMetadata = ({
  metadata,
  host,
  formattingLocale,
  openInStella,
}: {
  metadata: ReaderPager["metadata"] | undefined;
  host: ReaderController;
  formattingLocale: ReturnType<typeof appLocale>["formattingLocale"];
  openInStella: string;
}) => {
  const webUrl = metadata?.appUrl;
  const format = createFormatter({ locale: formattingLocale });
  return (
    <>
      {" "}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {metadata !== undefined && (
          <DecisionIdentity
            caseNumber={metadata.caseNumber}
            court={metadata.court}
            courtAbbreviation={metadata.courtAbbreviation}
            courtTier={metadata.courtTier}
          />
        )}
        {webUrl !== null &&
          webUrl !== undefined &&
          parseLegalCitationHttpUrl(webUrl) !== null && (
            <Button
              variant="outline"
              onClick={() =>
                host.bridge.detached(
                  host.bridge.openLink(webUrl),
                  "open decision in stella",
                )
              }
            >
              {openInStella}
            </Button>
          )}
      </header>
      {metadata !== undefined && (
        <div className="text-muted-foreground mb-4 flex items-center gap-3 text-sm">
          {metadata.date !== null && (
            <time dateTime={metadata.date}>
              {format.dateTime(new Date(metadata.date), {
                dateStyle: "medium",
                timeZone: "UTC",
              })}
            </time>
          )}
          <BidiText as="span">{metadata.language}</BidiText>
        </div>
      )}
    </>
  );
};

const McpProvisionPreview = ({
  preview,
  host,
  openInStella,
}: {
  preview: ProvisionPreview;
  host: ReaderController;
  openInStella: string;
}) => {
  const previewUrl = preview.appUrl;
  return (
    <aside className="mt-4 space-y-2" lang={preview.language} dir="ltr">
      {previewUrl !== null && (
        <Button
          variant="outline"
          onClick={() =>
            host.bridge.detached(
              host.bridge.openLink(previewUrl),
              "open provision in stella",
            )
          }
        >
          {openInStella}
        </Button>
      )}
      {preview.blocks.map((block) => (
        <BlockRenderer
          key={block.id}
          block={{
            type: "paragraph",
            id: block.id,
            anchorId: block.anchorId,
            plainText: block.text,
            inlines: [{ type: "text", text: block.text }],
          }}
          activeMatchIndex={-1}
          rangesByPieceId={{}}
          variant="statute"
          anchorPresentation="embedded"
        />
      ))}
    </aside>
  );
};

const McpReaderStatus = ({
  state,
  openingStatus,
  bridgeStatus,
  unavailable,
  loading,
}: {
  state: ReturnType<ReaderController["getSnapshot"]>;
  openingStatus: OpenDecision["status"] | undefined;
  bridgeStatus: ReturnType<
    ReaderController["bridge"]["getSnapshot"]
  >["result"]["status"];
  unavailable: string;
  loading: string;
}) => (
  <>
    {" "}
    {state.document?.status === "withheld" && (
      <p role="status">{unavailable}</p>
    )}
    {(state.document?.status === "unavailable" ||
      openingStatus === "unavailable") && <p role="status">{unavailable}</p>}
    {(state.requestStatus === "loading" ||
      bridgeStatus === "idle" ||
      bridgeStatus === "loading") && <p role="status">{loading}</p>}
  </>
);

export const ReaderView = ({
  host,
  onBack,
}: {
  host: ReaderController;
  onBack?: () => void;
}) => {
  const state = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const bridgeState = useSyncExternalStore(
    host.bridge.subscribe,
    host.bridge.getSnapshot,
  );
  const landing = useRef({ key: "", opening: bridgeState.result });
  const { direction, messages, formattingLocale } = appLocale(
    bridgeState.context.locale,
  );
  const presentation = readerMessages(bridgeState.context.locale);
  const opened =
    bridgeState.result.status === "ready" ? bridgeState.result.view : undefined;
  const metadata = state.document?.metadata ?? opened?.metadata;
  const anchors =
    state.document === null ? undefined : anchorsFor(state.document, host);
  const target = host.range();
  const resolution =
    state.document === null || target === null
      ? null
      : resolveReaderRange(state.document, target);
  const landingIds =
    resolution?.type === "found"
      ? new Set(resolution.anchorIds)
      : new Set<string>();
  const mode = bridgeState.context.displayMode ?? "inline";
  const preview = state.preview;
  const error =
    state.requestStatus === "error" ||
    state.requestStatus === "conflict" ||
    state.previewStatus === "error" ||
    bridgeState.result.status === "error";
  return (
    <DirectionProvider direction={direction}>
      <TooltipProvider>
        <ReaderPresentationProvider
          adapters={{
            messages: presentation,
          }}
        >
          <main
            dir={direction}
            data-display-mode={mode}
            className="p-4 sm:p-6"
            ref={(element) => {
              if (element === null || onBack === undefined) {
                return undefined;
              }
              const handleKeyDown = (event: KeyboardEvent) => {
                if (event.key !== "Escape" || event.defaultPrevented) {
                  return;
                }
                event.preventDefault();
                onBack();
              };
              element.addEventListener("keydown", handleKeyDown);
              return () =>
                element.removeEventListener("keydown", handleKeyDown);
            }}
          >
            {onBack !== undefined && (
              <Button
                variant="ghost"
                onClick={containedEventHandler(() => onBack())}
                ref={focusReaderBack}
              >
                {presentation["common.back"]}
              </Button>
            )}
            <McpDecisionMetadata
              metadata={metadata}
              host={host}
              formattingLocale={formattingLocale}
              openInStella={messages.openInStella}
            />
            {(state.requestStatus === "conflict" ||
              state.documentRevision > 0) && (
              <p role="status" className="text-muted-foreground text-sm">
                {presentation["caseLaw.reader.documentUpdated"]}
              </p>
            )}
            {error && (
              <div
                role={state.requestStatus === "conflict" ? undefined : "alert"}
              >
                {state.requestStatus !== "conflict" && <p>{messages.error}</p>}
                <Button
                  variant="outline"
                  onClick={() =>
                    host.bridge.detached(host.retry(), "retry decision read")
                  }
                >
                  {messages.retry}
                </Button>
              </div>
            )}
            {state.document?.status === "available" && (
              <article
                data-slot="reader-text-root"
                className="reader-body mx-auto max-w-[var(--reader-measure)]"
                dir="ltr"
                lang={state.document.metadata.language}
                ref={(article) => {
                  if (
                    article === null ||
                    resolution?.type !== "found" ||
                    state.document?.status !== "available"
                  ) {
                    return;
                  }
                  const key = `${state.documentRevision}:${state.document.metadata.decisionId}:${resolution.firstAnchorId}`;
                  if (
                    landing.current.key === key &&
                    landing.current.opening === bridgeState.result
                  ) {
                    return;
                  }
                  const anchor = article.querySelector(
                    `#${CSS.escape(resolution.firstAnchorId)}`,
                  );
                  if (anchor !== null) {
                    anchor.scrollIntoView({ block: "center" });
                    landing.current = { opening: bridgeState.result, key };
                  }
                }}
              >
                {state.document.blocks.map((block) => (
                  <BlockRenderer
                    key={block.id}
                    block={block}
                    activeMatchIndex={-1}
                    rangesByPieceId={{}}
                    anchorsByPieceId={anchors}
                    variant="case-law"
                    landing={landingIds.has(block.anchorId)}
                  />
                ))}
              </article>
            )}
            <McpReaderStatus
              state={state}
              openingStatus={opened?.status}
              bridgeStatus={bridgeState.result.status}
              unavailable={presentation["caseLaw.viewer.textUnavailable"]}
              loading={messages.loading}
            />
            {state.document?.status === "available" &&
              !state.document.complete &&
              state.requestStatus !== "error" &&
              state.requestStatus !== "conflict" && (
                <Button
                  variant="outline"
                  disabled={state.requestStatus === "loading"}
                  onClick={() =>
                    host.bridge.detached(
                      host.loadNext(),
                      "load next decision page",
                    )
                  }
                >
                  {messages.next}
                </Button>
              )}
            {preview !== null && (
              <McpProvisionPreview
                preview={preview}
                host={host}
                openInStella={messages.openInStella}
              />
            )}
          </main>
        </ReaderPresentationProvider>
      </TooltipProvider>
    </DirectionProvider>
  );
};
