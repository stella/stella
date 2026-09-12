import { useState } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { panic } from "better-result";
import {
  CalendarClockIcon,
  DownloadIcon,
  EyeIcon,
  FileCheck2Icon,
  FileTextIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { StellaWordmark } from "@/components/stella-wordmark";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { loadAuthContext } from "@/routes/-auth-context";

export const Route = createFileRoute("/shared/$shareSpaceId")({
  beforeLoad: async ({ context, location }) => {
    const authContext = await loadAuthContext(context.queryClient);
    if (!authContext.session) {
      throw redirect({
        to: "/auth",
        search: { redirectTo: location.pathname },
        replace: true,
      });
    }
    return authContext;
  },
  head: () => ({
    meta: [
      { name: "robots", content: "noindex,nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: SharedDocumentPage,
});

function SharedDocumentPage() {
  const shareSpaceId = Route.useParams({
    select: (params) => params.shareSpaceId,
  });
  const t = useTranslations();
  const formatter = useFormatter();
  const [downloading, setDownloading] = useState(false);
  const manifestQuery = useQuery({
    queryKey: ["external-share", shareSpaceId, "manifest"],
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api["share-spaces"]
          .access({ shareSpaceId })
          .get({ fetch: { signal } }),
      ),
    retry: false,
  });
  const item = manifestQuery.data?.items[0];
  const itemId = item?.id;
  const displayUrlQuery = useQuery({
    queryKey: ["external-share", shareSpaceId, itemId, "display-url"],
    enabled: itemId !== undefined,
    queryFn: async ({ signal }) => {
      if (!itemId) {
        return panic("Missing shared item");
      }
      return unwrapEden(
        await api["share-spaces"]
          .access({ shareSpaceId })
          .items({ shareItemId: itemId })
          .url.get({ query: { kind: "display" }, fetch: { signal } }),
      );
    },
    staleTime: 4 * 60 * 1000,
    retry: false,
  });

  const download = async () => {
    if (!item) {
      return;
    }
    setDownloading(true);
    try {
      const result = unwrapEden(
        await api["share-spaces"]
          .access({ shareSpaceId })
          .items({ shareItemId: item.id })
          .url.get({ query: { kind: "download" } }),
      );
      window.location.assign(result.url);
    } catch (error) {
      stellaToast.add({
        title: userErrorFromThrown(error, t("sharing.viewer.downloadFailed")),
        type: "error",
      });
    } finally {
      setDownloading(false);
    }
  };

  if (manifestQuery.isPending) {
    return <ViewerLoading />;
  }
  if (manifestQuery.isError || !item) {
    return (
      <ExternalShareShell>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="border-border bg-background max-w-md rounded-2xl border p-8 text-center shadow-lg shadow-black/5">
            <div className="bg-muted text-muted-foreground mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl">
              <LockKeyholeIcon className="size-6" />
            </div>
            <h1 className="font-heading text-xl font-semibold">
              {t("sharing.viewer.unavailable")}
            </h1>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
              {t("sharing.viewer.unavailableDescription")}
            </p>
            <Button
              className="mt-5"
              onClick={() =>
                detached(manifestQuery.refetch(), "SharedDocument.retry")
              }
              variant="outline"
            >
              <RefreshCwIcon />
              {t("sharing.viewer.tryAgain")}
            </Button>
          </div>
        </div>
      </ExternalShareShell>
    );
  }

  const manifest = manifestQuery.data;
  let viewerContent;
  if (displayUrlQuery.isPending) {
    viewerContent = (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
        <div className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-xl">
          <FileTextIcon className="size-5 animate-pulse" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium">{t("sharing.viewer.preparing")}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("sharing.viewer.preparingHint")}
          </p>
        </div>
      </div>
    );
  } else if (displayUrlQuery.isError) {
    viewerContent = (
      <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
        <div className="bg-muted text-muted-foreground mb-4 flex size-11 items-center justify-center rounded-xl">
          <FileTextIcon className="size-5" />
        </div>
        <p className="font-medium">{t("sharing.viewer.previewUnavailable")}</p>
        <p className="text-muted-foreground mt-1 max-w-sm text-sm">
          {t("sharing.viewer.previewUnavailableHint")}
        </p>
        <Button
          className="mt-4"
          onClick={() =>
            detached(displayUrlQuery.refetch(), "SharedDocument.previewRetry")
          }
          size="sm"
          variant="outline"
        >
          <RefreshCwIcon />
          {t("sharing.viewer.tryAgain")}
        </Button>
      </div>
    );
  } else {
    viewerContent = (
      <iframe
        className="min-h-[72vh] w-full border-0"
        referrerPolicy="no-referrer"
        sandbox={
          manifest.downloadPolicy === "allowed"
            ? "allow-downloads allow-same-origin"
            : "allow-same-origin"
        }
        src={displayUrlQuery.data.url}
        title={item.displayName}
      />
    );
  }

  return (
    <ExternalShareShell>
      <header className="border-border/70 bg-background/95 sticky top-0 z-20 flex min-h-16 flex-wrap items-center justify-between gap-3 border-b px-5 py-3 backdrop-blur sm:px-7">
        <div className="flex min-w-0 items-center gap-4">
          <StellaWordmark className="h-5 w-auto shrink-0" />
          <div className="border-border min-w-0 border-s ps-4">
            <BidiText as="p" className="truncate text-sm font-semibold">
              {manifest.name}
            </BidiText>
            <p className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
              <ShieldCheckIcon className="size-3.5 text-[var(--option-emerald-fg)]" />
              {t("sharing.viewer.securelyShared")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="bg-muted text-muted-foreground hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs sm:flex">
            {manifest.downloadPolicy === "allowed" ? (
              <DownloadIcon className="size-3.5" />
            ) : (
              <EyeIcon className="size-3.5" />
            )}
            {manifest.downloadPolicy === "allowed"
              ? t("sharing.viewer.downloadAllowed")
              : t("folio.viewOnly")}
          </span>
          {manifest.downloadPolicy === "allowed" ? (
            <Button
              disabled={downloading}
              loading={downloading}
              onClick={() =>
                detached(download(), "SharedDocumentPage.download")
              }
              size="sm"
              variant="outline"
            >
              <DownloadIcon /> {t("sharing.viewer.download")}
            </Button>
          ) : null}
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-[96rem] flex-1 flex-col gap-3 p-3 sm:p-5 lg:p-6">
        <div className="border-border bg-background flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 shadow-xs">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/8 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <FileCheck2Icon className="size-4" />
            </div>
            <div className="min-w-0">
              <BidiText as="p" className="truncate text-sm font-medium">
                {item.displayName}
              </BidiText>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t("sharing.viewer.publishedSnapshot")}
              </p>
            </div>
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span>
              {t("sharing.viewer.version", {
                version: item.versionStamp ?? t("sharing.viewer.published"),
              })}
            </span>
            {manifest.expiresAt ? (
              <span className="flex items-center gap-1.5">
                <CalendarClockIcon className="size-3.5" />
                {t("sharing.viewer.expires", {
                  date: formatter.dateTime(new Date(manifest.expiresAt), {
                    dateStyle: "medium",
                  }),
                })}
              </span>
            ) : null}
          </div>
        </div>

        <div className="border-border bg-muted/20 flex min-h-[72vh] flex-1 overflow-hidden rounded-xl border shadow-lg shadow-black/5">
          {viewerContent}
        </div>

        <footer className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
          <span className="flex items-center gap-1.5">
            <LockKeyholeIcon className="size-3.5" />
            {t("sharing.viewer.privateSession")}
          </span>
          {item.verificationCode ? (
            <span className="bg-background rounded-full border px-2.5 py-1 font-mono">
              {t("sharing.viewer.verification", {
                code: item.verificationCode,
              })}
            </span>
          ) : null}
        </footer>
      </section>
    </ExternalShareShell>
  );
}

const ExternalShareShell = ({ children }: { children: ReactNode }) => (
  <main className="bg-muted/25 relative flex min-h-dvh flex-col overflow-hidden">
    <div className="bg-primary/5 pointer-events-none absolute -end-24 -top-32 size-96 rounded-full blur-3xl" />
    <div className="relative z-10 flex min-h-dvh flex-col">{children}</div>
  </main>
);

const ViewerLoading = () => {
  const t = useTranslations();
  return (
    <ExternalShareShell>
      <header className="border-border/70 bg-background flex h-16 items-center justify-between border-b px-6">
        <StellaWordmark className="h-5 w-auto" />
        <Skeleton className="h-8 w-24 rounded-full" />
      </header>
      <div className="mx-auto flex w-full max-w-[96rem] flex-1 flex-col gap-3 p-5 lg:p-6">
        <div className="border-border bg-background flex items-center gap-3 rounded-xl border p-4">
          <Skeleton className="size-9 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-44" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
        <div className="border-border bg-background flex min-h-[72vh] flex-1 items-center justify-center rounded-xl border">
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <ShieldCheckIcon className="text-primary size-4 animate-pulse" />
            {t("sharing.viewer.loading")}
          </div>
        </div>
      </div>
    </ExternalShareShell>
  );
};
