import { createContext, use, useId } from "react";
import type { MouseEvent, ReactElement, ReactNode } from "react";

import { queryOptions, useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { MenuItem } from "@stll/ui/menu";

import { desktopPresenceOptions } from "@/features/desktop/desktop-presence";
import { api } from "@/lib/api";
import { roleOptions } from "@/lib/auth-queries";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { deepLAvailabilityOptions } from "@/lib/deepl/queries";
import { unwrapEden } from "@/lib/errors/api";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { optionalOrganizationSettingsOptions } from "@/queries/organization-settings";

import {
  CAPABILITY_REASON_KEYS,
  resolveActionCapabilities,
} from "./action-capabilities.logic";
import type {
  ActionCapabilities,
  ActionDescriptor,
  Capability,
} from "./action-capabilities.logic";

const documentOcrAvailabilityOptions = (organizationId: string) =>
  queryOptions({
    queryKey: ["document-ocr-availability", organizationId],
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api["organization-settings"]["document-ocr-availability"].get({
          fetch: { signal },
        }),
      ),
    staleTime: 30_000,
  });

const ActionCapabilitiesContext = createContext<ActionCapabilities | null>(
  null,
);
/** Explicit fixtures use the same renderer and resolver contract as live surfaces. */
export const ActionCapabilitiesProvider = ({
  value,
  children,
}: {
  value: ActionCapabilities;
  children: ReactNode;
}) => (
  <ActionCapabilitiesContext value={value}>
    {children}
  </ActionCapabilitiesContext>
);

const useLiveActionCapabilities = (
  observe: boolean,
  capability: Capability | null | undefined,
): ActionCapabilities => {
  const user = useMaybeAuthenticatedUser();
  const organizationId = user?.activeOrganizationId ?? "";
  const enabled = observe && user !== null && capability !== null;
  const needs = (value: Capability) =>
    enabled &&
    (capability === undefined ||
      capability === value ||
      (capability === "translation" && (value === "ai" || value === "deepl")));
  const aiQuery = useQuery({
    ...aiAvailabilityOptions({ organizationId }),
    enabled: needs("ai"),
    retry: false,
  });
  const deeplQuery = useQuery(
    deepLAvailabilityOptions({ organizationId, open: needs("deepl") }),
  );
  const ocrQuery = useQuery({
    ...documentOcrAvailabilityOptions(organizationId),
    enabled: needs("ocr"),
    retry: false,
  });
  const desktopQuery = useQuery({
    ...desktopPresenceOptions({ organizationId, userId: user?.id ?? "" }),
    enabled: needs("desktop"),
  });
  const settingsQuery = useQuery({
    ...optionalOrganizationSettingsOptions({
      organizationId: user?.activeOrganizationId ?? null,
      userId: user?.id ?? "",
    }),
    enabled: needs("verification") || needs("legalLists"),
  });
  const roleQuery = useQuery({ ...roleOptions, enabled });
  const ai = useQueryView(aiQuery);
  const deepl = useQueryView(deeplQuery);
  const ocr = useQueryView(ocrQuery);
  const desktop = useQueryView(desktopQuery);
  const settings = useQueryView(settingsQuery);
  const role = useQueryView(roleQuery);
  useQueryViewError(ai);
  useQueryViewError(deepl);
  useQueryViewError(ocr);
  useQueryViewError(desktop);
  useQueryViewError(settings);
  useQueryViewError(role);
  return resolveActionCapabilities({
    role:
      role.type === "items" && role.refetchError === undefined
        ? role.items
        : undefined,
    ai:
      ai.type === "items" && ai.refetchError === undefined
        ? ai.items.available
        : undefined,
    deepl:
      deepl.type === "items" && deepl.refetchError === undefined
        ? deepl.items.configured
        : undefined,
    ocr:
      ocr.type === "items" && ocr.refetchError === undefined
        ? ocr.items.available
        : undefined,
    desktop:
      desktop.type === "items" && desktop.refetchError === undefined
        ? desktop.items.type
        : undefined,
    settings:
      settings.type === "items" && settings.refetchError === undefined
        ? settings.items
        : undefined,
  });
};

export const useActionCapabilities = (
  capability?: Capability | null,
): ActionCapabilities => {
  const fixture = use(ActionCapabilitiesContext);
  const live = useLiveActionCapabilities(fixture === null, capability);
  return fixture ?? live;
};

type CapabilityActionChildProps = {
  disabled?: boolean;
  "aria-disabled"?: boolean;
  "aria-describedby"?: string;
  onClick?: (event: MouseEvent) => void;
  onSelect?: () => void;
};
export const CapabilityAction = ({
  action,
  children,
  surface = "menu",
}: {
  action: ActionDescriptor;
  children: (props: CapabilityActionChildProps) => ReactElement;
  surface?: "menu" | "control";
}) => {
  const resolved = useActionCapabilities(action.capability);
  const t = useTranslations();
  const reasonId = useId();
  const state =
    action.capability === null
      ? null
      : resolved.capabilities[action.capability];
  if (state === null || state.type === "available") {
    return children({});
  }
  if (resolved.role === "member") {
    return null;
  }
  return (
    <>
      {children({
        disabled: surface === "menu" ? true : undefined,
        "aria-disabled": true,
        "aria-describedby": reasonId,
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
        },
        onSelect: undefined,
      })}
      <div className="text-muted-foreground flex items-center gap-2 px-2 text-xs">
        <span id={reasonId}>{t(CAPABILITY_REASON_KEYS[state.reason])}</span>
        {surface === "control" && (
          <a href={sanitizeHref(state.settingsLink)}>
            {t("organization.aiConfig.configure")}
          </a>
        )}
      </div>
      {surface === "menu" && (
        <MenuItem
          aria-describedby={reasonId}
          render={<a href={sanitizeHref(state.settingsLink)} />}
        >
          {t("organization.aiConfig.configure")}
        </MenuItem>
      )}
    </>
  );
};
