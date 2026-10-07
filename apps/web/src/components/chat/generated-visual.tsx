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
import { useOpenDecisionTab } from "@/features/case-law/open-decision-tab";
import { decisionOptions } from "@/features/case-law/queries/decisions";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { api } from "@/lib/api";
import { browserApiRootUrl } from "@/lib/api-url";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { unwrapEden } from "@/lib/errors/api";
import { detachedUserAction } from "@/lib/errors/user-toast";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { toSafeId } from "@/lib/safe-id";

import type {
  VisualFrameHandshake,
  VisualInteraction,
} from "./generated-visual.logic";
import {
  activateVisual,
  advanceVisualHandshake,
  pendingVisualHandshake,
  parseVisualHostMessage,
} from "./generated-visual.logic";
import { createVisualShellSession } from "./visual-shell-session";

type GeneratedVisualProps = {
  part: Extract<ChatPart, { type: "ui-resource" }>;
  organizationId: string;
  threadRef: ChatThreadRef;
};

type GeneratedVisualFrameProps = Omit<GeneratedVisualProps, "part"> & {
  part: v.InferOutput<typeof generatedVisualPartSchema>;
};

// Tracks the current shell handshake and moves the view to preview when it
// settles. Any document load after that (a reload, or another document in the
// frame) also returns the view to preview.
const useFrameHandshake = (
  setInteraction: (interaction: VisualInteraction) => void,
) => {
  const handshake = useRef<VisualFrameHandshake>(pendingVisualHandshake());
  return {
    restart: () => {
      handshake.current = pendingVisualHandshake();
    },
    advance: (event: "load" | "delivered") => {
      if (handshake.current.status === "settled") {
        if (event === "load") {
          setInteraction({ status: "preview" });
        }
        return;
      }
      handshake.current = advanceVisualHandshake(handshake.current, event);
      if (handshake.current.status === "settled") {
        setInteraction({ status: "preview" });
      }
    },
  };
};

const GeneratedVisualFrame = ({
  part,
  organizationId,
  threadRef,
}: GeneratedVisualFrameProps) => {
  const t = useTranslations();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  const [interaction, setInteraction] = useState<VisualInteraction>({
    status: "loading",
  });
  const handshake = useFrameHandshake(setInteraction);
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
  const newNonce = useLatestCallback(() => crypto.randomUUID());
  const shell = useMemo(
    () => createVisualShellSession({ url: sandboxUrl.href, newNonce }),
    [sandboxUrl.href, newNonce],
  );
  const attachFrame = useLatestCallback((element: HTMLIFrameElement | null) => {
    frame.current = element;
    if (element !== null) {
      handshake.restart();
      element.src = shell.beginLoad();
    }
  });
  const receive = useLatestCallback((event: MessageEvent<unknown>) => {
    if (!page.data) {
      return;
    }
    const frameWindow = frame.current?.contentWindow;
    if (
      shell.deliverRender({
        event,
        frameWindow,
        message: {
          type: "render",
          title: page.data.title,
          html: page.data.html,
          data: page.data.data,
          links: page.data.links,
        },
      })
    ) {
      handshake.advance("delivered");
      return;
    }
    if (shell.isReloadedShell({ event, frameWindow })) {
      const element = frame.current;
      if (element !== null) {
        handshake.restart();
        setInteraction({ status: "loading" });
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
      interaction,
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
  const activate = () => {
    const next = activateVisual(interaction, frame.current?.contentWindow);
    if (next === interaction) {
      return;
    }
    setInteraction(next);
    requestAnimationFrame(() => frame.current?.focus());
  };
  const loadShell = () => {
    handshake.advance("load");
  };
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
      className="overflow-hidden rounded-md border"
      aria-label={t("chat.generatedView")}
    >
      <header className="bg-muted/40 flex items-center justify-between gap-3 border-b px-3 py-2">
        <div className="min-w-0">
          <p className="text-muted-foreground text-xs">
            {t("chat.generatedView")}
          </p>
          <p className="truncate text-sm font-medium">{view.title}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={interaction.status === "loading"}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) {
              activate();
            }
          }}
        >
          {t("chat.activateGeneratedView")}
        </Button>
      </header>
      <div className="relative">
        <iframe
          ref={attachFrame}
          title={view.title}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          onLoad={loadShell}
          inert={interaction.status !== "interactive"}
          className="block w-full border-0"
          style={{ height }}
        />
        {interaction.status !== "interactive" && (
          <button
            type="button"
            className="absolute inset-0 cursor-pointer"
            aria-label={t("chat.activateGeneratedView")}
            disabled={interaction.status === "loading"}
            onClick={(event) => {
              if (event.nativeEvent.isTrusted) {
                activate();
              }
            }}
          />
        )}
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
