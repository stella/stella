import { Component } from "react";
import type { ContextType, ErrorInfo, ReactElement } from "react";

import { AnalyticsContext } from "@/lib/analytics/provider";
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
};

type ChatRenderErrorBoundaryState = {
  hasError: boolean;
};

// Contains one failing piece of a chat thread (a rich part or a whole
// message) so the rest of the thread and the composer keep rendering.
// Callers key it by the identity of what it wraps, which resets it when
// that content changes.
export class ChatRenderErrorBoundary extends Component<
  ChatRenderErrorBoundaryProps,
  ChatRenderErrorBoundaryState
> {
  static override contextType = AnalyticsContext;
  declare context: ContextType<typeof AnalyticsContext>;

  constructor(props: ChatRenderErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ChatRenderErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo) {
    const { surface } = this.props;
    this.context.captureError(
      new ClientTelemetryError({
        area: surface,
        message: CHAT_RENDER_SURFACES[surface],
        cause: error,
      }),
    );
  }

  override render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
