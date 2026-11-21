import { Component } from "react";
import type { ContextType, ErrorInfo, ReactElement } from "react";

import { AnalyticsContext } from "@/lib/analytics/provider";
import { reportErrorOnce } from "@/lib/analytics/reported-error";
import { ClientTelemetryError } from "@/lib/errors/telemetry";

// Every chat surface that contains a render failure locally names itself
// here, so a telemetry area cannot drift from its report message.
const CHAT_RENDER_SURFACES = Object.freeze({
  "chat-rich-content": "[Chat rich content] Rich content failed to render",
  "chat-message": "[Chat thread] Message failed to render",
} as const satisfies Record<string, string>);

type ChatRenderSurface = keyof typeof CHAT_RENDER_SURFACES;

type ChatRenderErrorBoundaryProps = {
  surface: ChatRenderSurface;
  children: ReactElement;
  fallback: ReactElement;
  /** The content it wraps; a new value retries a failed render. */
  resetOn?: unknown;
};

type ChatRenderErrorBoundaryState = {
  hasError: boolean;
  resetOn: unknown;
};

// Contains one failing piece of a chat thread (a rich part or a whole
// message) so the rest of the thread and the composer keep rendering.
// Callers key it by what it wraps and pass the content as `resetOn`, so a
// message that keeps its id while it streams retries once its content
// changes instead of staying on the fallback.
export class ChatRenderErrorBoundary extends Component<
  ChatRenderErrorBoundaryProps,
  ChatRenderErrorBoundaryState
> {
  static override contextType = AnalyticsContext;
  declare context: ContextType<typeof AnalyticsContext>;

  constructor(props: ChatRenderErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, resetOn: props.resetOn };
  }

  static getDerivedStateFromProps(
    props: ChatRenderErrorBoundaryProps,
    state: ChatRenderErrorBoundaryState,
  ): ChatRenderErrorBoundaryState | null {
    return Object.is(props.resetOn, state.resetOn)
      ? null
      : { hasError: false, resetOn: props.resetOn };
  }

  static getDerivedStateFromError(): Pick<
    ChatRenderErrorBoundaryState,
    "hasError"
  > {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo) {
    const { surface } = this.props;
    reportErrorOnce(error, () => {
      this.context.captureError(
        new ClientTelemetryError({
          area: surface,
          message: CHAT_RENDER_SURFACES[surface],
          cause: error,
        }),
        {
          fingerprintKey: `ChatRenderErrorBoundary:${surface}`,
          scope: {
            type: "handler",
            handlerId: `ChatRenderErrorBoundary:${surface}`,
          },
        },
      );
    });
  }

  override render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
