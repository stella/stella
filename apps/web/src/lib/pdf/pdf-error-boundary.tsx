import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

type PDFErrorBoundaryProps = {
  fallback: ReactNode;
  children: ReactNode;
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

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[PDF] Error:", error, info);
  }

  // oxlint-disable-next-line typescript-eslint/promise-function-async
  override render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
