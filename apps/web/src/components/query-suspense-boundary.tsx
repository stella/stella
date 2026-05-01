import { Component, Suspense } from "react";
import type { ErrorInfo, PropsWithChildren, ReactNode } from "react";

import { CancelledError, QueryErrorResetBoundary } from "@tanstack/react-query";

import { getAnalytics } from "@/lib/analytics/provider";
import { ClientTelemetryError } from "@/lib/errors";

type QuerySuspenseBoundaryProps = PropsWithChildren<{
  area: string;
  errorFallback: (props: { reset: () => void }) => ReactNode;
  suspenseFallback: ReactNode;
  onError?: ((error: Error) => void) | undefined;
  resetKeys?: readonly unknown[] | undefined;
}>;

export const QuerySuspenseBoundary = ({
  area,
  children,
  errorFallback,
  onError,
  resetKeys,
  suspenseFallback,
}: QuerySuspenseBoundaryProps) => (
  <QueryErrorResetBoundary>
    {({ reset }) => (
      <QueryErrorBoundary
        area={area}
        fallback={errorFallback}
        onError={onError}
        onReset={reset}
        resetKeys={resetKeys}
      >
        <Suspense fallback={suspenseFallback}>{children}</Suspense>
      </QueryErrorBoundary>
    )}
  </QueryErrorResetBoundary>
);

type QueryErrorBoundaryProps = PropsWithChildren<{
  area: string;
  fallback: (props: { reset: () => void }) => ReactNode;
  onError?: ((error: Error) => void) | undefined;
  onReset: () => void;
  resetKeys?: readonly unknown[] | undefined;
}>;

type QueryErrorBoundaryState = {
  error: Error | null;
};

class QueryErrorBoundary extends Component<
  QueryErrorBoundaryProps,
  QueryErrorBoundaryState
> {
  constructor(props: QueryErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): QueryErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo) {
    if (error instanceof CancelledError) {
      queueMicrotask(this.reset);
      return;
    }

    getAnalytics().captureError(
      new ClientTelemetryError({
        area: this.props.area,
        message: `[${this.props.area}] ${error.message}`,
        cause: error,
      }),
    );
    this.props.onError?.(error);
  }

  override componentDidUpdate(prevProps: QueryErrorBoundaryProps) {
    if (
      this.state.error !== null &&
      resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)
    ) {
      this.reset();
    }
  }

  reset = () => {
    this.props.onReset();
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error instanceof CancelledError) {
      return null;
    }

    if (this.state.error !== null) {
      return this.props.fallback({ reset: this.reset });
    }

    return this.props.children;
  }
}

const resetKeysChanged = (
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
) => {
  if (prev === next) {
    return false;
  }

  if (!prev || !next || prev.length !== next.length) {
    return true;
  }

  return next.some((key, index) => !Object.is(key, prev[index]));
};
