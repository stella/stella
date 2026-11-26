import { createElement, lazy, Suspense, useRef, useState } from "react";
import type { PropsWithChildren } from "react";

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
import { Button } from "@stll/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { useExternalSyncEffect, useMountEffect } from "@stll/ui/effects";
import { CaseLawIcon, ChevronRightIcon } from "@stll/ui/icons";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { ChatRenderErrorBoundary } from "@/components/chat/chat-render-error-boundary";
import type { ChatPart } from "@/components/chat/chat-ui-tools-types";
import { stellaAppDisclosure } from "@/components/chat/stella-app-disclosure.logic";
import type { StellaAppDisclosure } from "@/components/chat/stella-app-disclosure.logic";
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
import { useMessageLocale } from "@/i18n/message-locale";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { mcpAppSandboxUrl } from "@/lib/api-url";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { unwrapApiResponse } from "@/lib/errors/api";
import { ClientTelemetryError } from "@/lib/errors/telemetry";
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

/**
 * Why the host would not show a rich part. A part reaches the thread because
 * a writer meant it to show, so every refusal is a defect to find: each one
 * names itself here and is reported, never a quiet placeholder. A render
 * failure is not listed; the error boundary that catches it reports it.
 */
const RICH_CONTENT_REFUSALS = Object.freeze({
  "media-source": "A media part has no source the browser may play",
  "resource-contract": "An MCP App resource breaks its contract",
  "sandbox-origin": "The app sandbox shares the page's origin",
  renderer: "No renderer shows this resource type",
  "app-part-contract": "A stella app part breaks its contract",
  "app-thread": "A stella app part is shown outside a thread",
  "app-bundle": "The stella app's document did not load",
  "app-bundle-uri": "The stella app's document is for another app",
  "visual-thread": "A generated visual is shown outside a thread",
} as const satisfies Record<string, string>);

type RichContentRefusal = keyof typeof RICH_CONTENT_REFUSALS;

const richContentRefusalReport = (
  refusal: RichContentRefusal,
  cause?: unknown,
) =>
  ({
    error: new ClientTelemetryError({
      area: "chat-rich-content",
      message: `[Chat rich content] ${RICH_CONTENT_REFUSALS[refusal]}`,
      ...(cause === undefined ? {} : { cause }),
    }),
    options: {
      fingerprintKey: `ChatRichContent.refused:${refusal}`,
      scope: {
        type: "handler",
        handlerId: `ChatRichContent.refused:${refusal}`,
      },
      context: { type: "detached", operation: "chat.rich-content.render" },
    },
  }) as const;

/** The placeholder for a refused part, reported once per mount. */
const RichContentRefused = ({
  refusal,
  cause,
}: {
  refusal: RichContentRefusal;
  cause?: unknown;
}) => {
  const analytics = useAnalytics();
  useMountEffect(() => {
    const report = richContentRefusalReport(refusal, cause);
    analytics.captureError(report.error, report.options);
  });
  return <RichContentStatus />;
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
  const analytics = useAnalytics();
  // The renderer shows its own error text in the frame (a sandbox that never
  // answered, a bridge that failed); the report is what makes it visible.
  const reportFrameFailure = (error: Error) => {
    analytics.captureError(
      new ClientTelemetryError({
        area: "chat-rich-content",
        message: "[Chat rich content] The app frame failed",
        cause: error,
      }),
      {
        fingerprintKey: "ChatRichContent.frame:failed",
        scope: { type: "handler", handlerId: "ChatRichContent.frame:failed" },
        context: { type: "detached", operation: "chat.rich-content.frame" },
      },
    );
  };
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
            onError={reportFrameFailure}
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
    return <RichContentRefused refusal="media-source" />;
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
  const sandboxUrl = withMcpAppFrameTitle(mcpAppSandboxUrl(), frameTitle);
  const normalized = normalizeUiResourcePart(part);
  if (!normalized) {
    return <RichContentRefused refusal="resource-contract" />;
  }
  const isServerRender = typeof window === "undefined";
  if (!isServerRender && sandboxUrl.origin === window.location.origin) {
    return <RichContentRefused refusal="sandbox-origin" />;
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
  const sandboxUrl = withMcpAppFrameTitle(mcpAppSandboxUrl(), frameTitle);
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
  const bridge = ((): McpAppBridge => {
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
  })();
  if (bundle.isPending) {
    return (
      <div className="min-h-32 w-full overflow-hidden rounded-md border">
        <RichContentStatus loading />
      </div>
    );
  }
  if (bundle.isError) {
    return <RichContentRefused refusal="app-bundle" cause={bundle.error} />;
  }
  if (bundle.data.uri !== part.resource.uri) {
    return <RichContentRefused refusal="app-bundle-uri" />;
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
  if (!parsed.success) {
    return <RichContentRefused refusal="app-part-contract" />;
  }
  if (threadRef === undefined) {
    return <RichContentRefused refusal="app-thread" />;
  }
  // The frame needs the browser; the server renders the place it loads into.
  if (typeof window === "undefined") {
    return (
      <div className="min-h-32 w-full overflow-hidden rounded-md border">
        <RichContentStatus loading />
      </div>
    );
  }
  // Checked before the app's document is fetched: a sandbox on the page's
  // own origin is refused by the sandbox itself.
  if (mcpAppSandboxUrl().origin === window.location.origin) {
    return <RichContentRefused refusal="sandbox-origin" />;
  }
  const frame = <StellaAppFrame part={parsed.output} threadRef={threadRef} />;
  const disclosure = stellaAppDisclosure(
    stellaAppDirectory(parsed.output.resource.uri),
    readStellaMcpAppCall(parsed.output),
  );
  switch (disclosure.type) {
    case "open":
      return frame;
    case "case-law":
      return (
        <CaseLawAppDisclosure disclosure={disclosure}>
          {frame}
        </CaseLawAppDisclosure>
      );
    default:
      disclosure satisfies never;
      return panic("Unhandled stella app disclosure");
  }
};

/**
 * A case-law result list starts as one line: what was searched and how many
 * decisions came back. The app, and its document request, load on first open
 * and then stay mounted, so closing and reopening keeps the reader's own
 * filters and scroll position.
 */
const CaseLawAppDisclosure = ({
  children,
  disclosure,
}: PropsWithChildren<{
  disclosure: Extract<StellaAppDisclosure, { type: "case-law" }>;
}>) => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  return (
    <Collapsible
      className="w-full min-w-0"
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) {
          setHasOpened(true);
        }
      }}
      open={isOpen}
    >
      <CollapsibleTrigger render={<Button size="sm" variant="muted" />}>
        <CaseLawIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="text-foreground shrink-0 font-medium">
          {t("common.caseLaw")}
        </span>
        {disclosure.query.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <TruncatedText hint={false} render={<span />}>
              {disclosure.query}
            </TruncatedText>
          </>
        )}
        {disclosure.decisionCount !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 tabular-nums">
              {t("caseLaw.citation.decisionCount", {
                count: disclosure.decisionCount,
              })}
            </span>
          </>
        )}
        <DirectionalIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150",
            isOpen && "rotate-90",
          )}
          flip={!isOpen}
          icon={ChevronRightIcon}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {hasOpened && <div className="pt-1">{children}</div>}
      </CollapsiblePanel>
    </Collapsible>
  );
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
            return <RichContentRefused refusal="visual-thread" />;
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
          return <RichContentRefused refusal="renderer" />;
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
