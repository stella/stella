import { startTransition, useEffect, useState } from "react";

import { Avatar, AvatarFallback } from "@stll/ui/components/avatar";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { FramePanel } from "@stll/ui/components/frame";
import { Label } from "@stll/ui/components/label";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Separator } from "@stll/ui/components/separator";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/components/tabs";
import { cn } from "@stll/ui/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslations } from "use-intl";

import { isAppSnapshot } from "../shared/rpc";
import type {
  AppSnapshot,
  DesktopNotificationPreferences,
  DesktopUpdateSnapshot,
  LinkedAccountSnapshot,
} from "../shared/rpc";
import stellaFavicon from "./stella-favicon.svg";

const DEFAULT_NOTIFICATION_PREFERENCES = {
  documentReady: true,
  revisionCreated: true,
  syncIssues: true,
} satisfies DesktopNotificationPreferences;
const DEFAULT_UPDATE_SNAPSHOT = {
  baseUrl: null,
  channel: null,
  currentHash: null,
  currentVersion: null,
  lastCheckedAt: null,
  latestHash: null,
  latestVersion: null,
  status: "disabled",
  statusMessage: "Update checks are not configured yet.",
  updateAvailable: false,
  updateReady: false,
} satisfies DesktopUpdateSnapshot;

const PREFERENCES_TABS = ["general", "notifications", "about"] as const;

type PreferencesTab = (typeof PREFERENCES_TABS)[number];
type NotificationPreferenceKey = keyof DesktopNotificationPreferences;

const NOTIFICATION_PREFERENCE_KEYS = [
  "documentReady",
  "syncIssues",
  "revisionCreated",
] as const satisfies readonly NotificationPreferenceKey[];

const isMacDesktop = navigator.userAgent.includes("Mac");

const isPreferencesTab = (value: string | null): value is PreferencesTab =>
  value !== null && (PREFERENCES_TABS as readonly string[]).includes(value);

const getInitialTab = (): PreferencesTab => {
  const tab = window.location.hash.replace(/^#/, "");
  return isPreferencesTab(tab) ? tab : "general";
};

const getAccountInitials = (linkedAccount: LinkedAccountSnapshot | null) => {
  if (!linkedAccount) {
    return "S";
  }

  if (linkedAccount.name?.trim()) {
    return linkedAccount.name
      .split(" ")
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }

  return linkedAccount.email.slice(0, 2).toUpperCase();
};

const suppressTransitions = () => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
  void getComputedStyle(document.documentElement).opacity;
  return () => requestAnimationFrame(() => style.remove());
};

const useSystemTheme = () => {
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const root = document.documentElement;

    const updateTheme = () => {
      const restore = suppressTransitions();
      const isDark = mediaQuery.matches;
      root.classList.toggle("dark", isDark);
      root.style.colorScheme = isDark ? "dark" : "light";
      restore();
    };

    updateTheme();
    mediaQuery.addEventListener("change", updateTheme);

    return () => {
      mediaQuery.removeEventListener("change", updateTheme);
    };
  }, []);
};

type SettingRowProps = {
  helper?: string;
  label: string;
  value: string;
};

const SettingRow = ({ helper, label, value }: SettingRowProps) => (
  <div className="flex items-start justify-between gap-4 px-4 py-3">
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium">{label}</p>
      {helper ? (
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
          {helper}
        </p>
      ) : null}
    </div>
    <p className="text-muted-foreground max-w-40 text-right text-sm leading-relaxed">
      {value}
    </p>
  </div>
);

type NotificationRowProps = {
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
  preferenceKey: NotificationPreferenceKey;
};

const NotificationRow = ({
  checked,
  description,
  disabled = false,
  label,
  onCheckedChange,
  preferenceKey,
}: NotificationRowProps) => {
  const inputId = `notification-${preferenceKey}`;

  return (
    <div className={cn("px-4 py-3", disabled && "opacity-64")}>
      <Label className="items-start gap-3" htmlFor={inputId}>
        <Checkbox
          checked={checked}
          className="mt-0.5"
          data-disabled={disabled ? "" : undefined}
          disabled={disabled}
          id={inputId}
          onCheckedChange={(nextChecked) => {
            onCheckedChange(nextChecked);
          }}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{label}</span>
          <span className="text-muted-foreground mt-1 block text-sm leading-relaxed">
            {description}
          </span>
        </span>
      </Label>
    </div>
  );
};

const PanelGroup = ({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) => (
  <section className="space-y-2">
    {title ? (
      <h2 className="text-muted-foreground px-1 text-[11px] font-medium tracking-[0.08em] uppercase">
        {title}
      </h2>
    ) : null}
    <div className="bg-background overflow-hidden rounded-xl border">
      {children}
    </div>
  </section>
);

const AutoStartToggle = () => {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    invoke<boolean>("is_autostart_enabled")
      .then(setEnabled)
      .catch(() => setEnabled(null));
  }, []);

  if (enabled === null) {
    return null;
  }

  return (
    <div className="px-4 py-3">
      <Label className="items-start gap-3" htmlFor="autostart-toggle">
        <Checkbox
          checked={enabled}
          className="mt-0.5"
          id="autostart-toggle"
          onCheckedChange={(checked) => {
            setEnabled(checked);
            void invoke<boolean>("set_autostart", { enabled: checked });
          }}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t("startOnLogin")}</span>
          <span className="text-muted-foreground mt-1 block text-sm leading-relaxed">
            {t("startOnLoginDescription")}
          </span>
        </span>
      </Label>
    </div>
  );
};

const GeneralPane = ({
  linkedAccount,
}: {
  linkedAccount: LinkedAccountSnapshot | null;
}) => {
  const t = useTranslations("settings");

  return (
    <div className="space-y-4">
      <PanelGroup>
        <div className="flex items-center gap-3 px-4 py-4">
          <Avatar className="size-10 border">
            <AvatarFallback>{getAccountInitials(linkedAccount)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {linkedAccount?.name?.trim() ||
                linkedAccount?.email ||
                t("stellaDesktop")}
            </p>
            <p className="text-muted-foreground truncate text-sm">
              {linkedAccount?.email ?? t("linkDevice")}
            </p>
          </div>
          <span
            className={cn(
              "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium",
              linkedAccount
                ? "border-success/20 bg-success/10 text-success-foreground"
                : "bg-muted text-muted-foreground border-border",
            )}
          >
            {linkedAccount ? t("connected") : t("notConnected")}
          </span>
        </div>
        {linkedAccount ? (
          <>
            <Separator />
            <SettingRow
              label={t("lastVerified")}
              value={
                linkedAccount.verifiedAt
                  ? new Date(linkedAccount.verifiedAt).toLocaleString([], {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : t("notAvailableYet")
              }
            />
          </>
        ) : null}
        <Separator />
        <AutoStartToggle />
      </PanelGroup>
    </div>
  );
};

const NotificationsPane = ({
  notificationPreferences,
  onPreferenceChange,
  ready,
}: {
  notificationPreferences: DesktopNotificationPreferences;
  onPreferenceChange: (
    key: NotificationPreferenceKey,
    checked: boolean,
  ) => void;
  ready: boolean;
}) => {
  const t = useTranslations("settings");

  const items = NOTIFICATION_PREFERENCE_KEYS.map((key) => {
    const first = key[0] ?? "";
    const labelKey =
      `notification${first.toUpperCase()}${key.slice(1)}` as const;
    const descKey = `${labelKey}Description` as const;
    return { key, label: t(labelKey), description: t(descKey) };
  });

  return (
    <div className="space-y-4">
      <PanelGroup>
        {items.map((item, index) => (
          <div key={item.key}>
            {index > 0 ? <Separator /> : null}
            <NotificationRow
              checked={notificationPreferences[item.key]}
              description={item.description}
              disabled={!ready}
              label={item.label}
              onCheckedChange={(checked) => {
                onPreferenceChange(item.key, checked);
              }}
              preferenceKey={item.key}
            />
          </div>
        ))}
      </PanelGroup>
    </div>
  );
};

const AboutPane = ({
  onCopyDiagnostics,
  onEmailSupport,
  onRevealSupportRoot,
  update,
}: {
  onCopyDiagnostics: () => void;
  onEmailSupport: () => void;
  onRevealSupportRoot: () => void;
  update: DesktopUpdateSnapshot;
}) => {
  const t = useTranslations("settings");

  const versionLabel =
    update.currentVersion ??
    (import.meta.env.DEV ? t("developmentBuild") : t("previewBuild"));

  return (
    <div className="space-y-4">
      <PanelGroup>
        <div className="flex flex-col items-center px-4 pt-6 pb-2">
          <img
            alt="stella"
            className="size-16 shrink-0 rounded-2xl"
            src={stellaFavicon}
          />
          <p className="mt-3 text-sm font-semibold">{t("stellaDesktop")}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">{versionLabel}</p>
        </div>
      </PanelGroup>

      <PanelGroup title={t("support")}>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <p className="text-sm">hello@stll.app</p>
          <Button onClick={onEmailSupport} size="sm" variant="outline">
            {t("email")}
          </Button>
        </div>
        <Separator />
        <div className="flex items-center gap-2 px-4 py-3">
          <Button
            className="flex-1"
            onClick={onCopyDiagnostics}
            size="sm"
            variant="outline"
          >
            {t("copyDiagnostics")}
          </Button>
          <Button
            className="flex-1"
            onClick={onRevealSupportRoot}
            size="sm"
            variant="ghost"
          >
            {t("revealAppData")}
          </Button>
        </div>
      </PanelGroup>
    </div>
  );
};

export default function App() {
  useSystemTheme();

  const t = useTranslations("settings");
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<AppSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<PreferencesTab>(getInitialTab);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.hash = activeTab;
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [activeTab]);

  // Listen for tab activation from Rust backend
  useEffect(() => {
    let cleanup: (() => void) | undefined;

    void listen<{ tab: string }>("activate-tab", (event) => {
      const nextTab = event.payload.tab;
      if (isPreferencesTab(nextTab)) {
        setActiveTab(nextTab);
      }
    }).then((unlisten) => {
      cleanup = unlisten;
    });

    return () => {
      cleanup?.();
    };
  }, []);

  // Listen for state changes from Rust backend + initial fetch
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    void listen<AppSnapshot>("state-changed", (event) => {
      if (disposed) {
        return;
      }

      const detail = event.payload;
      if (!isAppSnapshot(detail)) {
        return;
      }

      startTransition(() => {
        setError(null);
        setState(detail);
      });
    }).then((unlisten) => {
      cleanup = unlisten;
    });

    const syncState = async () => {
      try {
        const nextState = await invoke<AppSnapshot>("get_state");
        if (disposed) {
          return;
        }

        startTransition(() => {
          setError(null);
          setState(nextState);
        });
      } catch (fetchError) {
        if (disposed) {
          return;
        }

        setError(
          fetchError instanceof Error
            ? fetchError.message
            : t("errorReadState"),
        );
      }
    };

    void syncState();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [t]);

  const notificationPreferences =
    state?.notificationPreferences ?? DEFAULT_NOTIFICATION_PREFERENCES;
  const update = state?.update ?? DEFAULT_UPDATE_SNAPSHOT;

  const handlePreferenceChange = async (
    preferenceKey: NotificationPreferenceKey,
    checked: boolean,
  ) => {
    if (!state) {
      return;
    }

    const previousPreferences = state.notificationPreferences;
    const nextPreferences = {
      ...previousPreferences,
      [preferenceKey]: checked,
    };

    startTransition(() => {
      setState((currentState) =>
        currentState
          ? {
              ...currentState,
              notificationPreferences: nextPreferences,
            }
          : currentState,
      );
    });

    try {
      const nextState = await invoke<AppSnapshot>(
        "update_notification_preferences",
        { prefs: nextPreferences },
      );

      startTransition(() => {
        setError(null);
        setState(nextState);
      });
    } catch (updateError) {
      startTransition(() => {
        setState((currentState) =>
          currentState
            ? {
                ...currentState,
                notificationPreferences: previousPreferences,
              }
            : currentState,
        );
        setError(
          updateError instanceof Error
            ? updateError.message
            : t("errorUpdatePreferences"),
        );
      });
    }
  };

  const handleCopyDiagnostics = async () => {
    try {
      await invoke<boolean>("copy_diagnostics");
      setError(null);
    } catch (copyError) {
      setError(
        copyError instanceof Error
          ? copyError.message
          : t("errorCopyDiagnostics"),
      );
    }
  };

  const handleEmailSupport = async () => {
    try {
      await invoke<boolean>("email_support");
      setError(null);
    } catch (emailError) {
      setError(
        emailError instanceof Error
          ? emailError.message
          : t("errorEmailSupport"),
      );
    }
  };

  const handleRevealSupportRoot = async () => {
    try {
      await invoke<boolean>("reveal_support_root");
      setError(null);
    } catch (revealError) {
      setError(
        revealError instanceof Error
          ? revealError.message
          : t("errorRevealAppData"),
      );
    }
  };

  return (
    <main className="bg-background text-foreground min-h-screen">
      <div
        className={cn(
          "mx-auto flex h-screen max-w-[30rem] flex-col px-4 pb-4",
          isMacDesktop ? "pt-9" : "pt-4",
        )}
      >
        <header className="pb-2">
          <p className="text-muted-foreground text-[11px] font-medium tracking-[0.14em] uppercase">
            {t("stellaDesktop")}
          </p>
          <h1 className="mt-1 text-xl font-semibold">{t("title")}</h1>
        </header>

        <Tabs
          className="min-h-0 flex-1 gap-2"
          onValueChange={(value: unknown) => {
            const nextTab = typeof value === "string" ? value : null;
            if (isPreferencesTab(nextTab)) {
              setActiveTab(nextTab);
            }
          }}
          value={activeTab}
        >
          <div className="px-1">
            <TabsList variant="underline">
              <TabsTab className="h-8 px-2 text-sm" value="general">
                {t("general")}
              </TabsTab>
              <TabsTab className="h-8 px-2 text-sm" value="notifications">
                {t("notifications")}
              </TabsTab>
              <TabsTab className="h-8 px-2 text-sm" value="about">
                {t("about")}
              </TabsTab>
            </TabsList>
          </div>

          {error ? (
            <div className="border-destructive/20 bg-destructive/10 text-destructive-foreground mx-1 rounded-lg border px-3 py-2 text-sm">
              {error}
            </div>
          ) : null}

          <FramePanel className="min-h-0 flex-1 overflow-hidden p-0">
            <TabsPanel className="h-full min-h-0" value="general">
              <ScrollArea className="h-full">
                <div className="space-y-4 p-4">
                  <GeneralPane linkedAccount={state?.linkedAccount ?? null} />
                </div>
              </ScrollArea>
            </TabsPanel>
            <TabsPanel className="h-full min-h-0" value="notifications">
              <ScrollArea className="h-full">
                <div className="space-y-4 p-4">
                  <NotificationsPane
                    notificationPreferences={notificationPreferences}
                    onPreferenceChange={handlePreferenceChange}
                    ready={state !== null}
                  />
                </div>
              </ScrollArea>
            </TabsPanel>
            <TabsPanel className="h-full min-h-0" value="about">
              <ScrollArea className="h-full">
                <div className="space-y-4 p-4">
                  <AboutPane
                    onCopyDiagnostics={() => {
                      void handleCopyDiagnostics();
                    }}
                    onEmailSupport={() => {
                      void handleEmailSupport();
                    }}
                    onRevealSupportRoot={() => {
                      void handleRevealSupportRoot();
                    }}
                    update={update}
                  />
                </div>
              </ScrollArea>
            </TabsPanel>
          </FramePanel>
        </Tabs>
      </div>
    </main>
  );
}
