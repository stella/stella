import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { getAnalytics } from "@/lib/analytics/provider";
import { ClientTelemetryError } from "@/lib/errors";

type PDFErrorBoundaryProps = {
  fallback: ReactNode;
  children: ReactNode;
  onError?: ((error: Error) => void) | undefined;
};

type PDFErrorBoundaryState = {
  hasError: boolean;
};

export class PDFErrorBoundary extends Component<
  PDFErrorBoundaryProps,
  PDFErrorBoundaryState
> {
  constructor(props: PDFErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): PDFErrorBoundaryState {
    return { hasError: true };
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

  // oxlint-disable-next-line typescript-eslint/promise-function-async
  override render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
