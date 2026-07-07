import { lazy, Suspense, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { LoadedCatalogueEntry } from "@stll/catalogue";
import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useMountEffect } from "@/hooks/use-effect";
import { installCatalogueEntry } from "@/lib/catalogue-install";
import { userErrorFromThrown } from "@/lib/errors";

const SignInDialog = lazy(async () => {
  const module = await import("@/components/auth/sign-in-dialog");
  return { default: module.SignInDialog };
});

type AddToStellaProps = {
  entry: LoadedCatalogueEntry;
  displayName: string;
  installIntent: boolean;
  onClearInstallIntent: () => void;
};

/**
 * Client-only "Add to Stella" affordance. Logged out: opens the sign-in
 * dialog with a redirect back to this entry carrying `?install=1`.
 * Logged in (or returning with that intent): installs via the shared
 * `installCatalogueEntry` path and toasts the outcome. Never on the SSR
 * path — the page renders fully without a session.
 */
export function AddToStella({
  entry,
  displayName,
  installIntent,
  onClearInstallIntent,
}: AddToStellaProps) {
  const t = useTranslations();
  const authStatus = useClientAuthStatus();
  const queryClient = useQueryClient();
  const [authRedirectTo, setAuthRedirectTo] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => await installCatalogueEntry(entry),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp"] });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      stellaToast.add({
        title: t("catalogue.installed", { name: displayName }),
        type: "success",
      });
    },
    onError: (error) => {
      stellaToast.add({
        title: t("catalogue.installFailed"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
        type: "error",
      });
    },
  });

  const runInstall = () => {
    if (mutation.isPending) {
      return;
    }
    mutation.mutate();
  };

  const handleClick = () => {
    if (authStatus.isAuthenticated) {
      runInstall();
      return;
    }
    if (authStatus.status === "checking") {
      return;
    }
    setAuthRedirectTo(`/tools/${entry.slug}?install=1`);
  };

  return (
    <>
      <Button
        disabled={authStatus.status === "checking" || mutation.isPending}
        onClick={handleClick}
        type="button"
      >
        <PlusIcon className="size-4" />
        {t("publicTools.addToStella")}
      </Button>

      {/* Mounts only once the session resolves to authenticated with a
          pending intent, so the mount-only effect fires exactly when we
          want and never before auth is known. */}
      {authStatus.isAuthenticated && installIntent && (
        <InstallOnArrival
          onArrive={() => {
            runInstall();
            onClearInstallIntent();
          }}
        />
      )}

      {authRedirectTo !== null && (
        <Suspense fallback={null}>
          <SignInDialog
            onOpenChange={(open) => {
              if (!open) {
                setAuthRedirectTo(null);
              }
            }}
            open
            redirectTo={authRedirectTo}
          />
        </Suspense>
      )}
    </>
  );
}

function InstallOnArrival({ onArrive }: { onArrive: () => void }) {
  useMountEffect(() => {
    onArrive();
  });
  return null;
}
