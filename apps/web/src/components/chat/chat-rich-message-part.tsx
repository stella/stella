import {
  Component,
  createElement,
  lazy,
  Suspense,
  useMemo,
  useRef,
} from "react";
import type { ErrorInfo, ReactElement } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  CHAT_RICH_PART_LIMITS,
  isBoundedBase64Content,
  MCP_APP_FRAME_TITLE_HASH_PARAM,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";

import type { ChatPart } from "@/components/chat/chat-ui-tools";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { getAnalytics } from "@/lib/analytics/provider";
import { mcpAppSandboxUrl } from "@/lib/api-url";
import { ClientTelemetryError } from "@/lib/errors/telemetry";
import { getUserFileContentUrl } from "@/lib/user-files";

export type RichChatPart = Extract<
  ChatPart,
  { type: "audio" | "ui-resource" | "video" }
>;
type MediaChatPart = Extract<RichChatPart, { type: "audio" | "video" }>;
type UiResourcePart = Extract<RichChatPart, { type: "ui-resource" }>;

const LazyMcpAppResource = lazy(async () => {
  const { MCPAppResource } = await import("@tanstack/ai-react/mcp-apps");
  return { default: MCPAppResource };
});

const CHAT_RICH_CONTENT_AREA = "chat-rich-content";

type RichContentErrorBoundaryProps = {
  children: ReactElement;
  fallback: ReactElement;
};

type RichContentErrorBoundaryState = {
  hasError: boolean;
};

export class RichContentErrorBoundary extends Component<
  RichContentErrorBoundaryProps,
  RichContentErrorBoundaryState
> {
  constructor(props: RichContentErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): RichContentErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo) {
    getAnalytics().captureError(
      new ClientTelemetryError({
        area: CHAT_RICH_CONTENT_AREA,
        message: "[Chat rich content] MCP App resource failed to render",
        cause: error,
      }),
    );
  }

  override render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

export const isRichChatPart = (part: ChatPart): part is RichChatPart =>
  part.type === "audio" || part.type === "video" || part.type === "ui-resource";

export const toRenderableMediaSource = (part: MediaChatPart): string | null => {
  const mimePrefix = `${part.type}/`;
  const { source } = part;
  const { mimeType } = source;
  if (
    mimeType !== undefined &&
    mimeType.length > CHAT_RICH_PART_LIMITS.mediaMimeTypeMaxChars
  ) {
    return null;
  }
  switch (source.type) {
    case "data":
      if (
        mimeType === undefined ||
        !mimeType.startsWith(mimePrefix) ||
        !isBoundedBase64Content(
          source.value,
          CHAT_RICH_PART_LIMITS.inlineMediaMaxChars,
        )
      ) {
        return null;
      }
      return `data:${mimeType};base64,${source.value}`;
    case "url": {
      if (mimeType && !mimeType.startsWith(mimePrefix)) {
        return null;
      }
      if (source.value.length > CHAT_RICH_PART_LIMITS.mediaUrlMaxChars) {
        return null;
      }
      const storedFileUrl = getUserFileContentUrl(source.value);
      if (storedFileUrl) {
        return storedFileUrl;
      }
      if (!URL.canParse(source.value)) {
        return null;
      }
      const { protocol } = new URL(source.value);
      return protocol === "http:" || protocol === "https:"
        ? source.value
        : null;
    }
    default: {
      source satisfies never;
      return panic(`Unhandled source: ${String(source)}`);
    }
  }
};

const decodeBase64Utf8 = (value: string): string | null => {
  if (
    !isBoundedBase64Content(
      value,
      CHAT_RICH_PART_LIMITS.uiResourceContentMaxChars,
    )
  ) {
    return null;
  }
  const padding = (4 - (value.length % 4)) % 4;
  const decoded = atob(`${value}${"=".repeat(padding)}`);
  const bytes = Uint8Array.from(
    decoded,
    (character) => character.codePointAt(0) ?? 0,
  );
  return new TextDecoder().decode(bytes);
};

export const normalizeUiResourcePart = (
  part: UiResourcePart,
): UiResourcePart | null => {
  const { resource } = part;
  if (
    !resource.uri.startsWith("ui://") ||
    resource.uri.length > CHAT_RICH_PART_LIMITS.uiResourceUriMaxChars ||
    resource.mimeType !== MCP_APP_RESOURCE_MIME_TYPE
  ) {
    return null;
  }

  const resourceText = resource.text;
  const resourceBlob = resource.blob;
  let text: string | null;
  if (typeof resourceText === "string") {
    if (typeof resourceBlob === "string") {
      return null;
    }
    text = resourceText;
  } else {
    if (typeof resourceBlob !== "string") {
      return null;
    }
    text = decodeBase64Utf8(resourceBlob);
  }
  if (
    text === null ||
    text.length === 0 ||
    text.length > CHAT_RICH_PART_LIMITS.uiResourceContentMaxChars
  ) {
    return null;
  }

  return {
    type: "ui-resource",
    resource: {
      uri: resource.uri,
      mimeType: MCP_APP_RESOURCE_MIME_TYPE,
      text,
    },
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    ...(part.serverId === undefined ? {} : { serverId: part.serverId }),
    ...(part.meta === undefined ? {} : { meta: part.meta }),
  };
};

const RichContentStatus = ({ loading = false }: { loading?: boolean }) => {
  const t = useTranslations();
  return (
    <div
      aria-busy={loading || undefined}
      className="bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 text-sm"
    >
      {t(loading ? "chat.richContentLoading" : "chat.richContentUnavailable")}
    </div>
  );
};

export const withMcpAppFrameTitle = (
  sandboxUrl: URL,
  frameTitle: string,
): URL => {
  const titledUrl = new URL(sandboxUrl);
  const hashParams = new URLSearchParams(titledUrl.hash.slice(1));
  hashParams.set(MCP_APP_FRAME_TITLE_HASH_PARAM, frameTitle);
  titledUrl.hash = hashParams.toString();
  return titledUrl;
};

export const applyMcpAppFrameTitle = (
  frame: { title: string } | null,
  frameTitle: string,
): void => {
  if (frame) {
    frame.title = frameTitle;
  }
};

const McpAppFrame = ({
  frameTitle,
  normalized,
  sandboxUrl,
}: {
  frameTitle: string;
  normalized: UiResourcePart;
  sandboxUrl: URL;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  useExternalSyncEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const titleFrames = () => {
      applyMcpAppFrameTitle(container.querySelector("iframe"), frameTitle);
    };
    titleFrames();
    const observer = new MutationObserver(titleFrames);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [frameTitle]);

  return (
    <div
      className="min-h-32 w-full overflow-hidden rounded-md border"
      ref={containerRef}
    >
      <RichContentErrorBoundary
        fallback={<RichContentStatus />}
        key={`${normalized.toolCallId}:${normalized.resource.uri}`}
      >
        <Suspense fallback={<RichContentStatus loading />}>
          <LazyMcpAppResource part={normalized} sandbox={{ url: sandboxUrl }} />
        </Suspense>
      </RichContentErrorBoundary>
    </div>
  );
};

const MediaPart = ({ part }: { part: MediaChatPart }) => {
  const t = useTranslations();
  const source = toRenderableMediaSource(part);
  if (!source) {
    return <RichContentStatus />;
  }
  const mimeType = part.source.mimeType;
  if (part.type === "audio") {
    return createElement("audio", {
      "aria-label": t("chat.audioContent"),
      className: "w-full max-w-xl",
      controls: true,
      preload: "none",
      src: source,
    });
  }
  return createElement(
    "video",
    {
      "aria-label": t("chat.videoContent"),
      className: "bg-foreground aspect-video w-full max-w-2xl rounded-md",
      controls: true,
      preload: "none",
    },
    createElement("source", {
      src: source,
      ...(mimeType ? { type: mimeType } : {}),
    }),
  );
};

const UiResource = ({ part }: { part: UiResourcePart }) => {
  const t = useTranslations();
  const frameTitle = t("chat.richContentTitle");
  const sandboxUrl = useMemo(
    () => withMcpAppFrameTitle(mcpAppSandboxUrl(), frameTitle),
    [frameTitle],
  );
  const normalized = normalizeUiResourcePart(part);
  if (!normalized) {
    return <RichContentStatus />;
  }
  const isServerRender = typeof window === "undefined";
  if (!isServerRender && sandboxUrl.origin === window.location.origin) {
    return <RichContentStatus />;
  }

  if (isServerRender) {
    return (
      <div className="min-h-32 w-full overflow-hidden rounded-md border">
        <RichContentStatus loading />
      </div>
    );
  }

  return (
    <McpAppFrame
      frameTitle={frameTitle}
      normalized={normalized}
      sandboxUrl={sandboxUrl}
    />
  );
};

export const ChatRichMessagePart = ({ part }: { part: RichChatPart }) => {
  switch (part.type) {
    case "audio":
    case "video":
      return <MediaPart part={part} />;
    case "ui-resource":
      return <UiResource part={part} />;
    default: {
      part satisfies never;
      return panic(`Unhandled part: ${String(part)}`);
    }
  }
};
