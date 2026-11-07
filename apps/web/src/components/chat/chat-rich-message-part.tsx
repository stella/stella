import { createElement, lazy, Suspense, useMemo, useRef } from "react";

import type { AppRendererProps } from "@mcp-ui/client";
import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  CHAT_RICH_PART_LIMITS,
  isBoundedBase64Content,
  MCP_APP_FRAME_TITLE_HASH_PARAM,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";
import {
  readStellaMcpAppCall,
  stellaMcpAppBundleSchema,
  stellaMcpAppPartSchema,
} from "@stll/api-contract/stella-mcp-app";

import { ChatRenderErrorBoundary } from "@/components/chat/chat-render-error-boundary";
import type { ChatPart } from "@/components/chat/chat-ui-tools";
import {
  createStellaAppToolCaller,
  openStellaAppLink,
  STELLA_APP_HOST_CAPABILITIES,
  stellaAppDirectory,
  stellaAppHostContext,
  stellaAppToolResult,
} from "@/components/chat/stella-mcp-app-bridge";
import { uiResourceRenderer } from "@/components/chat/ui-resource-renderer";
import { useTheme } from "@/components/theme-provider";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useMessageLocale } from "@/i18n/message-locale";
import { api } from "@/lib/api";
import { mcpAppSandboxUrl } from "@/lib/api-url";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { unwrapApiResponse } from "@/lib/errors/api";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { toSafeId } from "@/lib/safe-id";
import { getUserFileContentUrl } from "@/lib/user-files";

export type RichChatPart = Extract<
  ChatPart,
  { type: "audio" | "ui-resource" | "video" }
>;
type MediaChatPart = Extract<RichChatPart, { type: "audio" | "video" }>;
type UiResourcePart = Extract<RichChatPart, { type: "ui-resource" }>;

const LazyAppRenderer = lazy(async () => {
  const { AppRenderer } = await import("@mcp-ui/client");
  return { default: AppRenderer };
});

/**
 * What a host answers an app with. Omitted, the app is display-only: a call
 * or link it asks for is refused, as for an inline MCP App resource.
 */
type McpAppBridge = Pick<
  AppRendererProps,
  | "toolInput"
  | "toolResult"
  | "hostContext"
  | "hostCapabilities"
  | "onCallTool"
  | "onOpenLink"
>;

const LazyGeneratedVisual = lazy(async () => {
  const { GeneratedVisual } =
    await import("@/components/chat/generated-visual");
  return { default: GeneratedVisual };
});

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
    // A provider file handle has no browser URL.
    case "file":
      return null;
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
  bridge,
  frameTitle,
  html,
  sandboxUrl,
  toolCallId,
  toolName,
  uri,
}: {
  bridge?: McpAppBridge | undefined;
  frameTitle: string;
  html: string;
  sandboxUrl: URL;
  toolCallId: string;
  toolName: string;
  uri: string;
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
      <ChatRenderErrorBoundary
        surface="chat-rich-content"
        fallback={<RichContentStatus />}
        key={`${toolCallId}:${uri}`}
      >
        <Suspense fallback={<RichContentStatus loading />}>
          <LazyAppRenderer
            html={html}
            sandbox={{ url: sandboxUrl }}
            toolName={toolName}
            toolResourceUri={uri}
            {...bridge}
          />
        </Suspense>
      </ChatRenderErrorBoundary>
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
      html={normalized.resource.text ?? ""}
      sandboxUrl={sandboxUrl}
      toolCallId={normalized.toolCallId}
      toolName={normalized.toolName}
      uri={normalized.resource.uri}
    />
  );
};

type StellaAppPart = v.InferOutput<typeof stellaMcpAppPartSchema>;

/**
 * One of stella's own apps, for the call the server ran. The document is the
 * server's bundle; the app is handed the call's arguments and result, and
 * its tool calls go back to the server, which holds them to the app's
 * manifest and runs them as this member.
 */
const StellaAppFrame = ({
  part,
  threadRef,
}: {
  part: StellaAppPart;
  threadRef: ChatThreadRef;
}) => {
  const t = useTranslations();
  const locale = useMessageLocale();
  const { resolvedTheme } = useTheme();
  const frameTitle = t("chat.richContentTitle");
  const sandboxUrl = useMemo(
    () => withMcpAppFrameTitle(mcpAppSandboxUrl(), frameTitle),
    [frameTitle],
  );
  const directory = stellaAppDirectory(part.resource.uri) ?? "";
  const bundle = useQuery({
    queryKey: ["stella-mcp-app-bundle", directory],
    queryFn: async ({ signal }) =>
      v.parse(
        stellaMcpAppBundleSchema,
        unwrapApiResponse(
          await api.chat["mcp-apps"]({ app: directory }).get({
            fetch: { signal },
          }),
        ),
      ),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const bridge = useMemo((): McpAppBridge => {
    const call = readStellaMcpAppCall(part);
    const thread = api.chat.threads({
      threadId: toSafeId<"chatThread">(threadRef.threadId),
    });
    const appCalls = thread["mcp-apps"]({ toolCallId: part.toolCallId });
    // An app's tool call is a read the server runs for the app; it is not
    // an automation capability of its own.
    const callTool = createStellaAppToolCaller(
      async (request) =>
        await invokeAppOnlyWrite("chat.mcp-apps.call", async () =>
          unwrapApiResponse(await appCalls.call.post(request)),
        ),
    );
    return {
      toolInput: call.input,
      toolResult: stellaAppToolResult(call),
      hostContext: stellaAppHostContext({ theme: resolvedTheme, locale }),
      hostCapabilities: STELLA_APP_HOST_CAPABILITIES,
      onCallTool: callTool,
      onOpenLink: async ({ url }) =>
        await Promise.resolve(openStellaAppLink(url, openIsolatedWindow)),
    };
  }, [part, threadRef.threadId, resolvedTheme, locale]);
  if (bundle.isPending) {
    return (
      <div className="min-h-32 w-full overflow-hidden rounded-md border">
        <RichContentStatus loading />
      </div>
    );
  }
  if (
    bundle.isError ||
    bundle.data.uri !== part.resource.uri ||
    sandboxUrl.origin === window.location.origin
  ) {
    return <RichContentStatus />;
  }
  return (
    <McpAppFrame
      bridge={bridge}
      frameTitle={frameTitle}
      html={bundle.data.html}
      sandboxUrl={sandboxUrl}
      toolCallId={part.toolCallId}
      toolName={part.toolName}
      uri={part.resource.uri}
    />
  );
};

const StellaAppResource = ({
  part,
  threadRef,
}: {
  part: UiResourcePart;
  threadRef: ChatThreadRef | undefined;
}) => {
  const parsed = v.safeParse(stellaMcpAppPartSchema, part);
  if (
    !parsed.success ||
    threadRef === undefined ||
    typeof window === "undefined"
  ) {
    return <RichContentStatus />;
  }
  return <StellaAppFrame part={parsed.output} threadRef={threadRef} />;
};

type ChatRichMessagePartProps = {
  part: RichChatPart;
  organizationId?: string | undefined;
  threadRef?: ChatThreadRef | undefined;
};

export const ChatRichMessagePart = ({
  part,
  organizationId,
  threadRef,
}: ChatRichMessagePartProps) => {
  switch (part.type) {
    case "audio":
    case "video":
      return <MediaPart part={part} />;
    case "ui-resource": {
      const renderer = uiResourceRenderer(part.resource.mimeType);
      switch (renderer) {
        case "mcp-app":
          return <UiResource part={part} />;
        case "stella-app":
          return (
            <ChatRenderErrorBoundary
              surface="chat-rich-content"
              fallback={<RichContentStatus />}
            >
              <StellaAppResource part={part} threadRef={threadRef} />
            </ChatRenderErrorBoundary>
          );
        case "generated-visual":
          if (organizationId === undefined || threadRef === undefined) {
            return <RichContentStatus />;
          }
          return (
            <ChatRenderErrorBoundary
              surface="chat-rich-content"
              fallback={<RichContentStatus />}
            >
              <Suspense fallback={<RichContentStatus loading />}>
                <LazyGeneratedVisual
                  part={part}
                  organizationId={organizationId}
                  threadRef={threadRef}
                />
              </Suspense>
            </ChatRenderErrorBoundary>
          );
        case null:
          return <RichContentStatus />;
        default:
          renderer satisfies never;
          return panic("Unhandled UI resource renderer");
      }
    }
    default: {
      part satisfies never;
      return panic(`Unhandled part: ${String(part)}`);
    }
  }
};
