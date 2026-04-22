declare module "electrobun/bun" {
  export type UpdateStatusType =
    | "idle"
    | "checking"
    | "check-complete"
    | "no-update"
    | "update-available"
    | "downloading"
    | "download-starting"
    | "checking-local-tar"
    | "local-tar-found"
    | "local-tar-missing"
    | "fetching-patch"
    | "patch-found"
    | "patch-not-found"
    | "downloading-patch"
    | "applying-patch"
    | "patch-applied"
    | "patch-failed"
    | "extracting-version"
    | "patch-chain-complete"
    | "downloading-full-bundle"
    | "download-progress"
    | "decompressing"
    | "download-complete"
    | "applying"
    | "extracting"
    | "replacing-app"
    | "launching-new-version"
    | "complete"
    | "error";

  export type UpdateStatusEntry = {
    details?: {
      currentHash?: string;
      latestHash?: string;
    };
    message: string;
    status: UpdateStatusType;
    timestamp: number;
  };

  export const ApplicationMenu: {
    on(
      eventName: "application-menu-clicked",
      handler: (event: unknown) => void,
    ): void;
    setApplicationMenu(
      items: (
        | {
            accelerator?: string;
            action?: string;
            enabled?: boolean;
            label?: string;
            role?: string;
            submenu?: (
              | {
                  accelerator?: string;
                  action?: string;
                  enabled?: boolean;
                  label?: string;
                  role?: string;
                  type?: "normal";
                }
              | {
                  type: "divider";
                }
            )[];
            type?: "normal";
          }
        | {
            type: "divider";
          }
      )[],
    ): void;
  };

  export const BrowserView: {
    defineRPC<T>(config: unknown): unknown;
  };

  export class BrowserWindow {
    public constructor(options: {
      frame?: { height: number; width: number; x: number; y: number };
      rpc?: unknown;
      styleMask?: Record<string, boolean>;
      title?: string;
      titleBarStyle?: string;
      url?: string;
    });

    public focus(): void;
    public on(eventName: string, handler: (event: unknown) => void): void;
    public webview: {
      on(
        eventName:
          | "will-navigate"
          | "did-navigate"
          | "did-navigate-in-page"
          | "did-commit-navigation"
          | "dom-ready"
          | "download-started"
          | "download-progress"
          | "download-completed"
          | "download-failed",
        handler: (event: unknown) => void,
      ): void;
      rpc: {
        send: Record<string, (payload: unknown) => void>;
      };
    };
  }

  export class Tray {
    public constructor(options: {
      height?: number;
      image?: string;
      template?: boolean;
      title?: string;
      width?: number;
    });

    public on(eventName: string, handler: (event: unknown) => void): void;
    public setMenu(
      items: (
        | {
            action?: string;
            enabled?: boolean;
            label?: string;
            submenu?: (
              | {
                  action?: string;
                  enabled?: boolean;
                  label?: string;
                  type: "normal";
                  tooltip?: string;
                }
              | {
                  type: "divider";
                }
            )[];
            tooltip?: string;
            type: "normal";
          }
        | {
            type: "divider";
          }
      )[],
    ): void;
    public setImage(image: string): void;
    public setTitle(title: string): void;
  }

  export const Updater: {
    applyUpdate(): Promise<void>;
    checkForUpdate(): Promise<{
      error: string;
      hash: string;
      updateAvailable: boolean;
      updateReady: boolean;
      version: string;
    }>;
    downloadUpdate(): Promise<void>;
    onStatusChange(callback: ((entry: UpdateStatusEntry) => void) | null): void;
    localInfo: {
      baseUrl(): Promise<string>;
      channel(): Promise<string>;
      hash(): Promise<string>;
      version(): Promise<string>;
    };
  };

  export const Utils: {
    clipboardWriteText(text: string): void;
    isDockIconVisible(): boolean;
    openExternal(url: string): boolean;
    openPath(path: string): boolean;
    paths: {
      userData: string;
    };
    quit(): void;
    setDockIconVisible(visible: boolean): void;
    showItemInFolder(path: string): void;
    showNotification(input: {
      body?: string;
      silent?: boolean;
      subtitle?: string;
      title: string;
    }): void;
  };

  type OpenUrlEvent = {
    data: { url: string };
  };

  const Electrobun: {
    events: {
      on(eventName: "open-url", handler: (event: OpenUrlEvent) => void): void;
    };
  };

  export default Electrobun;
}
