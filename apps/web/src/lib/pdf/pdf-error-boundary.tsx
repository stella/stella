import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { getAnalytics } from "@/lib/analytics/provider";
import { ClientTelemetryError } from "@/lib/errors/telemetry";

/**
 * A node, or a function of the caught error so the fallback can branch on
 * what actually failed (e.g. a 400 "no display rendition" versus a
 * transient failure).
 */
export type PDFErrorFallback = ReactNode | ((error: Error) => ReactNode);

type PDFErrorBoundaryProps = {
  fallback?: PDFErrorFallback | undefined;
  children: ReactNode;
  onError?: ((error: Error) => void) | undefined;
};

type PDFErrorBoundaryState = {
  error: Error | null;
};

export class PDFErrorBoundary extends Component<
  PDFErrorBoundaryProps,
  PDFErrorBoundaryState
> {
  constructor(props: PDFErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): PDFErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo) {
    getAnalytics().captureError(
      new ClientTelemetryError({
        area: "pdf-viewer",
        message: `[PDF] ${error.message}`,
        cause: error,
      }),
    );
    this.props.onError?.(error);
  }

  // oxlint-disable-next-line typescript-eslint/promise-function-async -- React render() must stay sync; ReactNode children can be thenable
  override render() {
    const { error } = this.state;
    if (error !== null) {
      const { fallback } = this.props;
      if (typeof fallback === "function") {
        return fallback(error);
      }
      // A caught error must never render as a silent blank pane: a caller
      // that made no fallback decision gets the generic message instead of
      // null (an email in the full-screen viewer shipped as an empty screen
      // exactly this way).
      return fallback ?? <PDFErrorFallbackDefault />;
    }
    return this.props.children;
  }
}

const PDFErrorFallbackDefault = () => {
  const t = useTranslations();
  return (
    <div className="text-muted-foreground flex h-full min-h-32 items-center justify-center px-4 text-center text-sm">
      {t("common.somethingWentWrong")}
    </div>
  );
};
