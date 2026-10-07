import { Component, Fragment } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { AlertTriangleIcon, DownloadIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import {
  classifyViewerError,
  viewerRetryDelayMs,
} from "@/components/viewer/viewer-recovery.logic";
import type { ViewerErrorRecovery } from "@/components/viewer/viewer-recovery.logic";
import { getAnalytics } from "@/lib/analytics/provider";
import { ClientTelemetryError } from "@/lib/errors/telemetry";
import { reloadForStaleDeployment } from "@/lib/preload-error-recovery";

/**
 * Every surface that renders a file. Telemetry is keyed by it, so a viewer
 * that keeps failing shows up by name.
 */
export type ViewerSurface =
  | "chat-draft-docx"
  | "document-docx"
  | "document-office"
  | "document-pdf"
  | "email-attachment-pdf"
  | "external-reference-pdf"
  | "inspector-pdf"
  | "search-preview-pdf";

/**
 * What to show for a failure the server or the file answered for good. A
 * function may return `undefined` to keep the generic failed state for the
 * errors it does not recognise.
 */
type ViewerFinalFallback = ReactNode | ((error: Error) => ReactNode);

const resolveFinalFallback = (
  fallback: ViewerFinalFallback | undefined,
  error: Error,
): ReactNode => (typeof fallback === "function" ? fallback(error) : fallback);

export type RecoverableViewerBoundaryProps = {
  surface: ViewerSurface;
  children: ReactNode;
  /** Shown while an automatic retry or the app reload is under way. */
  pending?: ReactNode | undefined;
  /** Replaces the generic failed state for a `final` error (no rendition,
   *  no access); retries that run out always show the generic state, which
   *  can try again. */
  finalFallback?: ViewerFinalFallback | undefined;
  onDownload?: (() => void) | undefined;
  /** Called once a failure is shown to the user, not on self-healed ones. */
  onError?: ((error: Error) => void) | undefined;
  /** Test seam: the backoff before each automatic attempt. */
  retryDelaysMs?: readonly number[] | undefined;
};

const ViewerPending = () => {
  const t = useTranslations();
  return (
    <div className="flex h-full min-h-32 items-center justify-center">
      <Loader label={t("common.loading")} size="sm" />
    </div>
  );
};

type ViewerFailedProps = {
  onDownload: (() => void) | undefined;
  onRetry: () => void;
};

const ViewerFailed = ({ onDownload, onRetry }: ViewerFailedProps) => {
  const t = useTranslations();
  return (
    <div
      className="flex h-full min-h-32 flex-col items-center justify-center gap-3 px-6 text-center"
      role="alert"
    >
      <AlertTriangleIcon className="text-foreground-disabled size-8" />
      <p className="text-muted-foreground text-sm text-balance">
        {t("fileDetail.displayFailed")}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={onRetry} size="sm" variant="outline">
          {t("common.tryAgain")}
        </Button>
        {onDownload !== undefined && (
          <Button onClick={onDownload} size="sm" variant="ghost">
            <DownloadIcon />
            {t("common.download")}
          </Button>
        )}
      </div>
    </div>
  );
};

type ViewerFailure = "final" | "exhausted";

type ViewerBoundaryState =
  | { type: "rendering"; attempt: number; generation: number }
  | { type: "caught"; attempt: number; generation: number; error: Error }
  | { type: "recovering"; attempt: number; generation: number }
  | { type: "reloading"; generation: number }
  | {
      type: "failed";
      generation: number;
      error: Error;
      failure: ViewerFailure;
    };

type ViewerErrorBoundaryProps = RecoverableViewerBoundaryProps & {
  resetQueries: () => void;
};

class ViewerErrorBoundary extends Component<
  ViewerErrorBoundaryProps,
  ViewerBoundaryState
> {
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(props: ViewerErrorBoundaryProps) {
    super(props);
    this.state = { type: "rendering", attempt: 0, generation: 0 };
  }

  // React merges this into the current state, so the attempt and generation
  // of the render that threw carry over into the caught state.
  static getDerivedStateFromError(error: Error): Partial<ViewerBoundaryState> {
    return { type: "caught", error };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo) {
    const { state } = this;
    if (state.type !== "caught") {
      return;
    }
    const recovery = classifyViewerError(error);
    this.report({ error, recovery, attempt: state.attempt });
    switch (recovery.type) {
      case "reload-app": {
        if (reloadForStaleDeployment()) {
          this.setState({ type: "reloading", generation: state.generation });
          return;
        }
        this.fail({ error, failure: "exhausted" });
        return;
      }
      case "final": {
        this.fail({ error, failure: "final" });
        return;
      }
      case "retry": {
        const delayMs = viewerRetryDelayMs(
          state.attempt,
          this.props.retryDelaysMs,
        );
        if (delayMs === undefined) {
          this.fail({ error, failure: "exhausted" });
          return;
        }
        this.setState({
          type: "recovering",
          attempt: state.attempt + 1,
          generation: state.generation,
        });
        this.retryTimer = setTimeout(this.remount, delayMs);
        return;
      }
      default: {
        recovery satisfies never;
        panic(`Unhandled viewer recovery: ${String(recovery)}`);
      }
    }
  }

  override componentWillUnmount() {
    clearTimeout(this.retryTimer);
  }

  private report({
    error,
    recovery,
    attempt,
  }: {
    error: Error;
    recovery: ViewerErrorRecovery;
    attempt: number;
  }) {
    // A telemetry area is a plain slug (`TELEMETRY_AREA` in posthog.ts).
    const area = `viewer-${this.props.surface}`;
    getAnalytics().captureError(
      new ClientTelemetryError({
        area,
        message: `[${area}] ${recovery.type} after attempt ${String(attempt)}: ${error.message}`,
        cause: error,
      }),
    );
  }

  private fail({ error, failure }: { error: Error; failure: ViewerFailure }) {
    this.setState((state) => ({
      type: "failed",
      generation: state.generation,
      error,
      failure,
    }));
    this.props.onError?.(error);
  }

  /** Remount the viewer subtree with its failed queries reset. */
  private readonly remount = () => {
    this.props.resetQueries();
    this.setState((state) => {
      switch (state.type) {
        case "recovering": {
          return {
            type: "rendering",
            attempt: state.attempt,
            generation: state.generation + 1,
          };
        }
        case "failed": {
          return {
            type: "rendering",
            attempt: 0,
            generation: state.generation + 1,
          };
        }
        case "rendering":
        case "caught":
        case "reloading": {
          return null;
        }
        default: {
          state satisfies never;
          return panic(`Unhandled viewer state: ${String(state)}`);
        }
      }
    });
  };

  override render(): ReactNode {
    const { state } = this;
    switch (state.type) {
      case "rendering": {
        return (
          <Fragment key={state.generation}>{this.props.children}</Fragment>
        );
      }
      case "caught":
      case "recovering":
      case "reloading": {
        return this.props.pending ?? <ViewerPending />;
      }
      case "failed": {
        const custom =
          state.failure === "final"
            ? resolveFinalFallback(this.props.finalFallback, state.error)
            : undefined;
        if (custom !== undefined) {
          return custom;
        }
        return (
          <ViewerFailed
            onDownload={this.props.onDownload}
            onRetry={this.remount}
          />
        );
      }
      default: {
        state satisfies never;
        return panic(`Unhandled viewer state: ${String(state)}`);
      }
    }
  }
}

/**
 * One error boundary for every file viewer, so none can dead-end.
 *
 * A failure is classified (`classifyViewerError`): a stale build reloads the
 * app once, guarded against loops; a transient failure remounts the viewer
 * after a short backoff, resetting its failed queries first, so the file is
 * fetched through a fresh signed URL and a fresh PDF.js worker loads it; a
 * final failure, or retries that run out, shows a state that can try again
 * and download the file.
 */
export const RecoverableViewerBoundary = (
  props: RecoverableViewerBoundaryProps,
) => (
  <QueryErrorResetBoundary>
    {({ reset }) => <ViewerErrorBoundary {...props} resetQueries={reset} />}
  </QueryErrorResetBoundary>
);
