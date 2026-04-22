import { startTransition, useEffect, useState } from "react";

import { Electroview } from "electrobun/view";

import { Avatar, AvatarFallback } from "@stella/ui/components/avatar";
import { Button } from "@stella/ui/components/button";
import { Checkbox } from "@stella/ui/components/checkbox";
import { FramePanel } from "@stella/ui/components/frame";
import { Label } from "@stella/ui/components/label";
import { ScrollArea } from "@stella/ui/components/scroll-area";
import { Separator } from "@stella/ui/components/separator";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stella/ui/components/tabs";
import { cn } from "@stella/ui/lib/utils";

import { isAppSnapshot } from "../shared/rpc";
import type {
  AppSnapshot,
  DesktopNotificationPreferences,
  DesktopUpdateSnapshot,
  DesktopRPC,
  DesktopRpcClient,
  LinkedAccountSnapshot,
} from "../shared/rpc";
import stellaFavicon from "./stella-favicon.svg";

const ACTIVATE_TAB_EVENT = "stella:desktop-activate-tab";
type ActivateTabMessage = DesktopRPC["webview"]["messages"]["activateTab"];

const APP_BUILD_LABEL = import.meta.env.DEV
  ? "Development build"
  : "Preview build";

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

const NOTIFICATION_PREFERENCE_ITEMS = [
  {
    description: "Document opened, resumed, or latest draft recovered.",
    key: "documentReady",
    label: "Document ready",
  },
  {
    description: "Checkpoint, finalize, or handoff needs attention.",
    key: "syncIssues",
    label: "Sync issues",
  },
  {
    description: "A clean stella revision was created after finishing.",
    key: "revisionCreated",
    label: "Revision created",
  },
] satisfies readonly {
  description: string;
  key: NotificationPreferenceKey;
  label: string;
}[];

const rpc = Electroview.defineRPC<DesktopRPC>({
  handlers: {
    messages: {
      activateTab: ({ tab }: ActivateTabMessage) => {
        window.dispatchEvent(
          new CustomEvent<PreferencesTab>(ACTIVATE_TAB_EVENT, {
            detail: tab,
          }),
        );
      },
      stateChanged: ({ snapshot }: { snapshot: AppSnapshot }) => {
        window.dispatchEvent(
          new CustomEvent<AppSnapshot>("stella:desktop-state-changed", {
            detail: snapshot,
          }),
        );
      },
    },
    requests: {},
  },
});

const electroview = new Electroview<DesktopRPC>({ rpc });
const desktopRpc: DesktopRpcClient = electroview.rpc;
const isMacDesktop = navigator.userAgent.includes("Mac");

const isPreferencesTab = (value: string | null): value is PreferencesTab =>
  value !== null && (PREFERENCES_TABS as readonly string[]).includes(value);

const getInitialTab = (): PreferencesTab => {
  const tab = window.location.hash.replace(/^#/, "");
  return isPreferencesTab(tab) ? tab : "general";
};

const formatTimestamp = (value: string | null) => {
  if (!value) {
    return "Not available yet";
  }

  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const getUpdateStatusTone = (status: DesktopUpdateSnapshot["status"]) => {
  switch (status) {
    case "idle":
      return "border-border bg-muted text-muted-foreground";
    case "available":
      return "border-success/20 bg-success/10 text-success-foreground";
    case "ready":
      return "border-success/20 bg-success/10 text-success-foreground";
    case "checking":
      return "border-info/20 bg-info/10 text-info-foreground";
    case "downloading":
      return "border-info/20 bg-info/10 text-info-foreground";
    case "applying":
      return "border-info/20 bg-info/10 text-info-foreground";
    case "error":
      return "border-destructive/20 bg-destructive/10 text-destructive-foreground";
    case "disabled":
      return "border-border bg-muted text-muted-foreground";
    case "up_to_date":
      return "border-border bg-muted text-foreground";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
};

const getUpdateActionLabel = (update: DesktopUpdateSnapshot) => {
  if (update.updateReady) {
    return "Restart to update";
  }

  if (update.updateAvailable) {
    return update.status === "downloading"
      ? "Downloading..."
      : "Download update";
  }

  if (update.status === "checking") {
    return "Checking...";
  }

  if (update.status === "applying") {
    return "Restarting...";
  }

  return "Check now";
};

const isUpdateActionDisabled = (update: DesktopUpdateSnapshot) =>
  update.status === "checking" ||
  update.status === "downloading" ||
  update.status === "applying" ||
  (update.status === "disabled" && !update.updateReady);

const getAccountLabel = (linkedAccount: LinkedAccountSnapshot | null) =>
  linkedAccount?.name?.trim() || linkedAccount?.email || "No linked account";

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

const GeneralPane = ({
  linkedAccount,
}: {
  linkedAccount: LinkedAccountSnapshot | null;
}) => (
  <div className="space-y-4">
    <PanelGroup>
      <div className="flex items-center gap-3 px-4 py-4">
        <Avatar className="size-10 border">
          <AvatarFallback>{getAccountInitials(linkedAccount)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {getAccountLabel(linkedAccount)}
          </p>
          <p className="text-muted-foreground truncate text-sm">
            {linkedAccount?.email ??
              "Open a document from stella to link this device."}
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
          {linkedAccount ? "Connected" : "Not connected"}
        </span>
      </div>
      {linkedAccount ? (
        <>
          <Separator />
          <SettingRow
            label="Last verified"
            value={formatTimestamp(linkedAccount.verifiedAt)}
          />
        </>
      ) : null}
    </PanelGroup>
  </div>
);

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
}) => (
  <div className="space-y-4">
    <PanelGroup>
      {NOTIFICATION_PREFERENCE_ITEMS.map((item, index) => (
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

const AboutPane = ({
  onCopyDiagnostics,
  onEmailSupport,
  onRevealSupportRoot,
  onUpdateAction,
  update,
}: {
  onCopyDiagnostics: () => void;
  onEmailSupport: () => void;
  onRevealSupportRoot: () => void;
  onUpdateAction: () => void;
  update: DesktopUpdateSnapshot;
}) => (
  <div className="space-y-4">
    <PanelGroup>
      <div className="flex items-start gap-3 px-4 py-4">
        <img
          alt="stella app icon"
          className="h-12 w-12 shrink-0 rounded-2xl border object-cover"
          src={stellaFavicon}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">stella desktop</p>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
            Managed Word editing for stella.
          </p>
        </div>
      </div>
      <Separator />
      <div className="flex items-center justify-between gap-3 px-4 py-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {update.currentVersion ?? APP_BUILD_LABEL}
          </p>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
            stella labs, s.r.o.
          </p>
        </div>
        <Button
          disabled={isUpdateActionDisabled(update)}
          onClick={onUpdateAction}
          size="sm"
          variant="outline"
        >
          {getUpdateActionLabel(update)}
        </Button>
      </div>
      {update.status !== "disabled" ? (
        <>
          <Separator />
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <p className="text-sm font-medium">Update status</p>
            <span
              className={cn(
                "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium",
                getUpdateStatusTone(update.status),
              )}
            >
              {update.status === "up_to_date"
                ? "Up to date"
                : update.status === "ready"
                  ? "Ready to install"
                  : update.status === "available"
                    ? "Update available"
                    : update.status === "downloading"
                      ? "Downloading"
                      : update.status === "checking"
                        ? "Checking"
                        : update.status === "applying"
                          ? "Installing"
                          : update.status === "error"
                            ? "Needs attention"
                            : "Idle"}
            </span>
          </div>
        </>
      ) : null}
      <Separator />
      <div className="px-4 py-3">
        <p className="text-muted-foreground text-sm leading-relaxed">
          {update.statusMessage}
        </p>
      </div>
      {!update.baseUrl ? (
        <>
          <Separator />
          <div className="px-4 py-3">
            <p className="text-muted-foreground text-sm leading-relaxed">
              Updates will appear here once the release feed is configured.
            </p>
          </div>
        </>
      ) : null}
      <Separator />
      <div className="flex items-center justify-between gap-3 px-4 py-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Support</p>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
            hello@stll.app
          </p>
        </div>
        <Button onClick={onEmailSupport} size="sm" variant="outline">
          Email support
        </Button>
      </div>
      <Separator />
      <div className="flex flex-wrap gap-2 px-4 py-4">
        <Button onClick={onCopyDiagnostics} size="sm" variant="outline">
          Copy diagnostics
        </Button>
        <Button onClick={onRevealSupportRoot} size="sm" variant="ghost">
          Reveal app data
        </Button>
      </div>
    </PanelGroup>
  </div>
);

export default function App() {
  useSystemTheme();

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

  useEffect(() => {
    const handleActivateTab = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        return;
      }

      const nextTab = typeof event.detail === "string" ? event.detail : null;
      if (!isPreferencesTab(nextTab)) {
        return;
      }

      setActiveTab(nextTab);
    };

    window.addEventListener(ACTIVATE_TAB_EVENT, handleActivateTab);
    return () => {
      window.removeEventListener(ACTIVATE_TAB_EVENT, handleActivateTab);
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    const handleStateChanged = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        return;
      }

      const detail: unknown = event.detail;
      if (!isAppSnapshot(detail)) {
        return;
      }

      const nextState = detail;
      startTransition(() => {
        setError(null);
        setState(nextState);
      });
    };

    const syncState = async () => {
      try {
        const nextState = await desktopRpc.request.getState({});
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
            : "stella desktop could not read its current state.",
        );
      }
    };

    window.addEventListener("stella:desktop-state-changed", handleStateChanged);

    void syncState();

    return () => {
      disposed = true;
      window.removeEventListener(
        "stella:desktop-state-changed",
        handleStateChanged,
      );
    };
  }, []);

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
      const nextState = await desktopRpc.request.updateNotificationPreferences({
        notificationPreferences: nextPreferences,
      });

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
            : "stella desktop could not update notification settings.",
        );
      });
    }
  };

  const handleUpdateAction = async () => {
    try {
      const nextState = update.updateReady
        ? await desktopRpc.request.applyUpdate({})
        : update.updateAvailable
          ? await desktopRpc.request.downloadUpdate({})
          : await desktopRpc.request.checkForUpdates({});

      startTransition(() => {
        setError(null);
        setState(nextState);
      });
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "stella desktop could not complete the update action.",
      );
    }
  };

  const handleCopyDiagnostics = async () => {
    try {
      await desktopRpc.request.copyDiagnostics({});
      setError(null);
    } catch (copyError) {
      setError(
        copyError instanceof Error
          ? copyError.message
          : "stella desktop could not copy diagnostics.",
      );
    }
  };

  const handleEmailSupport = async () => {
    try {
      await desktopRpc.request.emailSupport({});
      setError(null);
    } catch (emailError) {
      setError(
        emailError instanceof Error
          ? emailError.message
          : "stella desktop could not open your mail app.",
      );
    }
  };

  const handleRevealSupportRoot = async () => {
    try {
      await desktopRpc.request.revealSupportRoot({});
      setError(null);
    } catch (revealError) {
      setError(
        revealError instanceof Error
          ? revealError.message
          : "stella desktop could not reveal app data.",
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
            stella desktop
          </p>
          <h1 className="mt-1 text-xl font-semibold">Settings</h1>
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
                General
              </TabsTab>
              <TabsTab className="h-8 px-2 text-sm" value="notifications">
                Notifications
              </TabsTab>
              <TabsTab className="h-8 px-2 text-sm" value="about">
                About
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
                    onUpdateAction={() => {
                      void handleUpdateAction();
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
