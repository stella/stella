import { useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  GENERATED_VISUAL_URI_PREFIX,
  generatedVisualPageSchema,
  generatedVisualPartSchema,
} from "@stll/api-contract/generated-visual";
import { createVisualActionGate } from "@stll/api-contract/visual-bridge-policy";
import { VISUAL_SANDBOX_PATH } from "@stll/api-contract/visual-sandbox";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";

import { useChatEditorManager } from "@/components/chat-editor-provider";
import type { ChatPart } from "@/components/chat/chat-ui-tools";
import { useTheme } from "@/components/theme-provider";
import { useOpenDecisionTab } from "@/features/case-law/open-decision-tab";
import { decisionOptions } from "@/features/case-law/queries/decisions";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { browserApiRootUrl } from "@/lib/api-url";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { unwrapEden } from "@/lib/errors/api";
import { detachedUserAction } from "@/lib/errors/user-toast";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { toSafeId } from "@/lib/safe-id";
import { createRandomValue } from "@/lib/uuid";

import { readVisualThemeOrOmit } from "./generated-visual-theme";
import { parseVisualHostMessage } from "./generated-visual.logic";
import { createVisualShellSession } from "./visual-shell-session";

type GeneratedVisualProps = {
  part: Extract<ChatPart, { type: "ui-resource" }>;
  organizationId: string;
  threadRef: ChatThreadRef;
};

type GeneratedVisualFrameProps = Omit<GeneratedVisualProps, "part"> & {
  part: v.InferOutput<typeof generatedVisualPartSchema>;
};

const GeneratedVisualFrame = ({
  part,
  organizationId,
  threadRef,
}: GeneratedVisualFrameProps) => {
  const t = useTranslations();
  const { resolvedTheme, palette } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
  const { insertPastedTextIntoThread } = useChatEditorManager();
  const { open: openDecision } = useOpenDecisionTab();
  const queries = useQueryClient();
  const fileId = toSafeId<"userFile">(
    part.resource.uri.slice(GENERATED_VISUAL_URI_PREFIX.length),
  );
  const sandboxUrl = new URL(browserApiRootUrl(VISUAL_SANDBOX_PATH));
  const page = useQuery({
    queryKey: ["generated-visual", organizationId, threadRef.threadId, fileId],
    queryFn: async ({ signal }) => {
      const response = await api["user-files"]({ fileId }).visual.get({
        fetch: { signal },
      });
      return v.parse(generatedVisualPageSchema, unwrapEden(response));
    },
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });
  const now = useLatestCallback(() => performance.now());
  const actionGate = useMemo(
    () =>
      page.data === undefined
        ? null
        : createVisualActionGate({
            data: page.data.data,
            links: page.data.links,
            literalLinks: page.data.literalLinks,
            now,
          }),
    [page.data, now],
  );
  const newNonce = useLatestCallback(() => createRandomValue());
  const shell = useMemo(
    () => createVisualShellSession({ url: sandboxUrl.href, newNonce }),
    [sandboxUrl.href, newNonce],
  );
  const attachFrame = useLatestCallback((element: HTMLIFrameElement | null) => {
    frame.current = element;
    if (element !== null) {
      element.src = shell.beginLoad();
    }
  });
  // A missing token stays missing until the app theme changes, so one report
  // per view is enough.
  const themeFailureReported = useRef(false);
  const readTheme = useLatestCallback(() =>
    readVisualThemeOrOmit({
      style: getComputedStyle(document.documentElement),
      appearance: document.documentElement.classList.contains("dark")
        ? "dark"
        : "light",
      report: (error) => {
        if (themeFailureReported.current) {
          return;
        }
        themeFailureReported.current = true;
        getAnalytics().captureError(error, {
          type: "detached",
          operation: "generated-visual.read-theme",
        });
      },
    }),
  );
  const syncTheme = useLatestCallback(() => {
    if (!shell.isReady()) {
      return;
    }
    const theme = readTheme();
    if (theme !== undefined) {
      frame.current?.contentWindow?.postMessage({ kind: "theme", theme }, "*");
    }
  });
  useExternalSyncEffect(() => {
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, [resolvedTheme, palette, syncTheme]);
  const receive = useLatestCallback((event: MessageEvent<unknown>) => {
    if (!page.data) {
      return;
    }
    const frameWindow = frame.current?.contentWindow;
    const theme = readTheme();
    if (
      shell.deliverRender({
        event,
        frameWindow,
        message: {
          type: "render",
          ...(theme === undefined ? {} : { theme }),
          title: page.data.title,
          html: page.data.html,
          data: page.data.data,
          links: page.data.links,
        },
      })
    ) {
      return;
    }
    if (shell.isReloadedShell({ event, frameWindow })) {
      const element = frame.current;
      if (element !== null) {
        element.src = shell.beginLoad();
      }
      return;
    }
    if (!shell.isReady()) {
      return;
    }
    const message = parseVisualHostMessage({
      event,
      frameWindow,
      outerOrigin: "null",
      actionGate,
      userActivated:
        "userActivation" in navigator && navigator.userActivation.isActive,
    });
    if (message === null) {
      return;
    }
    switch (message.kind) {
      case "resize":
        setHeight(message.height);
        return;
      case "ready":
        setHeight(message.size.height);
        return;
      case "open-link":
        setConfirmUrl(message.url);
        return;
      case "drill": {
        const text = t("chat.generatedViewDrill", {
          court: message.court,
          year: String(message.year),
        });
        insertPastedTextIntoThread(threadRef, {
          source: "prompt",
          label: text,
          text,
        });
        return;
      }
      case "open-internal": {
        const link = page.data.links.find(({ id }) => id === message.linkId);
        if (!link) {
          return;
        }
        detachedUserAction(
          (async () => {
            const decision = await queries.query(
              decisionOptions(link.decisionId),
            );
            openDecision({
              decisionId: decision.id,
              court: decision.court,
              country: decision.country,
              caseNumber: decision.caseNumber,
              language: decision.language,
              languageAlternates: decision.languageAlternates,
              slug: decision.slug,
            });
          })(),
          {
            context: "generated-visual.open-decision",
            failureMessage: t("common.error"),
          },
        );
        return;
      }
      default: {
        message satisfies never;
        panic("Unhandled visual message kind");
      }
    }
  });
  useExternalSyncEffect(() => {
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [receive]);
  if (page.isError) {
    return <p role="status">{t("chat.richContentUnavailable")}</p>;
  }
  if (!page.data) {
    return <p role="status">{t("chat.richContentLoading")}</p>;
  }
  if (sandboxUrl.origin === window.location.origin) {
    return <p role="status">{t("chat.richContentUnavailable")}</p>;
  }
  const view = page.data;
  const queryStart = confirmUrl?.indexOf("?") ?? -1;
  const fragmentStart = confirmUrl?.indexOf("#") ?? -1;
  const hasQuery =
    queryStart >= 0 && (fragmentStart < 0 || queryStart < fragmentStart);
  const queryEnd = fragmentStart < 0 ? confirmUrl?.length : fragmentStart;
  return (
    <section
      aria-label={t("chat.generatedView")}
      className="w-full min-w-0 space-y-1.5"
    >
      <header className="text-muted-foreground flex min-w-0 items-baseline gap-1.5 text-xs">
        <span className="shrink-0">{t("chat.generatedView")}</span>
        <span aria-hidden="true">·</span>
        <span className="text-foreground truncate font-medium">
          {view.title}
        </span>
      </header>
      <div className="overflow-hidden rounded-md border p-4">
        <iframe
          ref={attachFrame}
          onLoad={syncTheme}
          title={view.title}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          className="block w-full border-0"
          style={{ height }}
        />
      </div>
      <Dialog
        open={confirmUrl !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmUrl(null);
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t("inspector.external.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("inspector.external.confirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p
              dir="ltr"
              className="bg-muted rounded-md p-3 font-mono text-sm break-all"
            >
              {confirmUrl !== null && hasQuery ? (
                <>
                  {confirmUrl.slice(0, queryStart)}
                  <strong className="font-semibold">
                    {confirmUrl.slice(queryStart, queryEnd)}
                  </strong>
                  {confirmUrl.slice(queryEnd)}
                </>
              ) : (
                confirmUrl
              )}
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUrl(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (
                  confirmUrl === null ||
                  !view.literalLinks.includes(confirmUrl)
                ) {
                  return;
                }
                openIsolatedWindow(confirmUrl);
                setConfirmUrl(null);
              }}
            >
              {t("inspector.external.openLink")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
};

export const GeneratedVisual = ({
  part,
  organizationId,
  threadRef,
}: GeneratedVisualProps) => {
  const parsed = v.safeParse(generatedVisualPartSchema, part);
  const t = useTranslations();
  if (!parsed.success) {
    return <p role="status">{t("chat.richContentUnavailable")}</p>;
  }
  return (
    <GeneratedVisualFrame
      key={`${organizationId}:${parsed.output.resource.uri}`}
      part={parsed.output}
      organizationId={organizationId}
      threadRef={threadRef}
    />
  );
};
