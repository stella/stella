import { lazy, Suspense, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { LoadedCatalogueEntry } from "@stll/catalogue";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import {
  catalogueKeys,
  catalogueOptions,
} from "@/components/catalogue/catalogue-queries";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import type { TranslationKey } from "@/i18n/types";
import { authClient, type Role } from "@/lib/auth";
import { installCatalogueEntry } from "@/lib/catalogue-install";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { roleOptions } from "@/routes/-queries";
import { resolveAddToStellaState } from "@/routes/tools/-components/add-to-stella.logic";

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
 * Logged in with that intent (or returning after sign-in): opens a
 * confirmation dialog before installing, so a crafted `?install=1` link
 * can never install workspace-wide with zero clicks. A direct button
 * click is itself the confirmation and installs immediately. Never on the
 * SSR path — the page renders fully without a session.
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
  const organizationId = authStatus.isAuthenticated
    ? authStatus.user.activeOrganizationId
    : "";
  const roleQuery = useQuery({
    ...roleOptions,
    enabled: authStatus.isAuthenticated,
  });
  const catalogueQuery = useQuery({
    ...catalogueOptions(organizationId),
    enabled: authStatus.isAuthenticated,
  });
  const canInstall = resolveInstallPermission({
    authenticated: authStatus.isAuthenticated,
    isError: roleQuery.isError,
    role: roleQuery.data,
  });
  const organizationEntries = catalogueQuery.isError
    ? []
    : catalogueQuery.data?.entries;
  const state = resolveAddToStellaState({
    authStatus: authStatus.status,
    canInstall,
    entry,
    organizationEntries,
  });
  let buttonLabelKey: TranslationKey = "publicTools.addToStella";
  if (state.type === "forbidden") {
    buttonLabelKey = "errors.api.forbidden";
  } else if (state.type === "installed") {
    buttonLabelKey = "catalogue.installedShort";
  } else if (state.type === "unavailable") {
    buttonLabelKey = "catalogue.unavailable";
  }

  const mutation = useMutation({
    mutationFn: async () => await installCatalogueEntry(entry),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: catalogueKeys.all(organizationId),
        }),
        queryClient.invalidateQueries({ queryKey: ["mcp"] }),
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
      ]);
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
    if (state.type === "install") {
      runInstall();
      return;
    }
    if (state.type !== "sign-in") {
      return;
    }
    setAuthRedirectTo(`/tools/${entry.slug}?install=1`);
  };

  // Confirm, then clear the `install` intent from the URL (replace:true) so
  // it cannot re-fire on refresh or back navigation.
  const confirmInstall = () => {
    runInstall();
    onClearInstallIntent();
  };

  return (
    <>
      <Button
        disabled={
          mutation.isPending ||
          (state.type !== "install" && state.type !== "sign-in")
        }
        onClick={handleClick}
        type="button"
      >
        <PlusIcon className="size-4" />
        {t(buttonLabelKey)}
      </Button>

      {/* Renders only once the session resolves to authenticated with a
          pending intent. It never installs on its own: it asks first, and
          both confirm and cancel strip the `install` param from the URL. */}
      {state.type === "install" && installIntent && (
        <InstallConfirmDialog
          entry={entry}
          isPending={mutation.isPending}
          name={displayName}
          onCancel={onClearInstallIntent}
          onConfirm={confirmInstall}
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

type ResolveInstallPermissionOptions = {
  authenticated: boolean;
  isError: boolean;
  role: Role | undefined;
};

const resolveInstallPermission = ({
  authenticated,
  isError,
  role,
}: ResolveInstallPermissionOptions): boolean | undefined => {
  if (!authenticated) {
    return undefined;
  }
  if (isError) {
    return false;
  }
  if (role === undefined) {
    return undefined;
  }
  return authClient.organization.checkRolePermission({
    role,
    permissions: { organizationSettings: ["update"] },
  });
};

type InstallConfirmDialogProps = {
  entry: LoadedCatalogueEntry;
  name: string;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

function InstallConfirmDialog({
  entry,
  name,
  isPending,
  onConfirm,
  onCancel,
}: InstallConfirmDialogProps) {
  const t = useTranslations();

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onCancel();
    }
  };

  return (
    <AlertDialog onOpenChange={handleOpenChange} open>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("publicTools.installConfirm.title", { name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <InstallConfirmBody kind={entry.kind} name={name} />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </AlertDialogClose>
          <Button disabled={isPending} onClick={onConfirm} type="button">
            {t("publicTools.addToStella")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function InstallConfirmBody({
  kind,
  name,
}: {
  kind: LoadedCatalogueEntry["kind"];
  name: string;
}) {
  const t = useTranslations();

  if (kind === "mcp") {
    return t("publicTools.installConfirm.mcpBody", { name });
  }
  if (kind === "native-tool") {
    return t("publicTools.installConfirm.nativeToolBody", { name });
  }
  return t("publicTools.installConfirm.skillBody", { name });
}
