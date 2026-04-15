import { useEffect, useState } from "react";

import { Button } from "@stella/ui/components/button";

import type { SaveClipResponse } from "../../lib/messages";
import type { ClipData, Matter, PageMetadata } from "../../types";

type ClipFormProps = {
  activeMatter: Matter | null;
};

type SaveState =
  | { type: "idle" }
  | { type: "saving" }
  | { type: "success"; entityId: string }
  | { type: "queued" }
  | { type: "error"; message: string };

export const ClipForm = ({ activeMatter }: ClipFormProps) => {
  const [metadata, setMetadata] = useState<PageMetadata | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({
    type: "idle",
  });

  useEffect(() => {
    const fetchMetadata = () => {
      chrome.tabs.query(
        { active: true, currentWindow: true },
        (tabs: chrome.tabs.Tab[]) => {
          const tab = tabs[0];
          if (tab?.id === undefined) {
            return;
          }

          const favIconUrl = tab.favIconUrl ?? undefined;

          chrome.tabs.sendMessage(
            tab.id,
            { action: "get-page-metadata" },
            (response: { metadata?: PageMetadata }) => {
              if (chrome.runtime.lastError) {
                return;
              }
              if (response?.metadata) {
                setMetadata({
                  ...response.metadata,
                  favIconUrl,
                });
              }
            },
          );
        },
      );
    };

    fetchMetadata();

    // Re-fetch when the user switches tabs.
    const tabListener = (_activeInfo: chrome.tabs.OnActivatedInfo) => {
      setMetadata(null);
      // Small delay for the content script to inject.
      setTimeout(fetchMetadata, 300);
    };
    chrome.tabs.onActivated.addListener(tabListener);

    // Re-fetch when the active tab navigates.
    const navListener = (
      tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
    ) => {
      if (changeInfo.status !== "complete") {
        return;
      }
      chrome.tabs.query(
        { active: true, currentWindow: true },
        (tabs: chrome.tabs.Tab[]) => {
          if (tabs[0]?.id === tabId) {
            setTimeout(fetchMetadata, 300);
          }
        },
      );
    };
    chrome.tabs.onUpdated.addListener(navListener);

    // Update selection in real-time from content script.
    const messageListener = (message: { action: string; payload: unknown }) => {
      if (message.action === "selection-changed") {
        setMetadata((prev) => {
          if (!prev) {
            return prev;
          }
          const selection =
            typeof message.payload === "string" ? message.payload : undefined;
          return { ...prev, selection };
        });
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      chrome.tabs.onActivated.removeListener(tabListener);
      chrome.tabs.onUpdated.removeListener(navListener);
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []);

  const handleSave = async () => {
    if (!activeMatter || !metadata) {
      return;
    }

    setSaveState({ type: "saving" });

    const clipData: ClipData = {
      title: metadata.title || metadata.url,
      url: metadata.url,
      ...(metadata.selection ? { snippet: metadata.selection } : {}),
    };

    // SAFETY: chrome.runtime.sendMessage returns untyped;
    // we control the handler.
    // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    const response = (await chrome.runtime.sendMessage({
      action: "save-clip",
      payload: {
        matterId: activeMatter.id,
        data: clipData,
      },
    })) as SaveClipResponse | undefined;

    if (!response) {
      setSaveState({
        type: "error",
        message: "Extension background unavailable. Please reload.",
      });
      return;
    }

    if (response.success) {
      setSaveState({
        type: "success",
        entityId: response.entityId,
      });
      // Reset after a brief delay.
      setTimeout(() => setSaveState({ type: "idle" }), 2000);
    } else if (response.queued) {
      setSaveState({ type: "queued" });
      setTimeout(() => setSaveState({ type: "idle" }), 3000);
    } else {
      setSaveState({
        type: "error",
        message: response.error,
      });
    }
  };

  if (!metadata) {
    return (
      <section className="mb-5">
        <h2 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          Current page
        </h2>
        <p className="text-muted-foreground py-6 text-center text-[13px]">
          No page metadata available.
        </p>
      </section>
    );
  }

  const canSave = activeMatter !== null && saveState.type !== "saving";

  return (
    <section className="mb-5">
      <h2 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
        Current page
      </h2>
      <div className="border-border bg-card mb-2 rounded-lg border p-3">
        <div className="flex items-center gap-2">
          {metadata.favIconUrl ? (
            <img
              src={metadata.favIconUrl}
              alt=""
              width={16}
              height={16}
              className="size-4 shrink-0"
            />
          ) : (
            <div className="bg-muted size-4 shrink-0 rounded" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-foreground truncate text-sm font-medium">
              {metadata.title}
            </div>
            <div className="text-muted-foreground truncate text-xs">
              {metadata.url}
            </div>
          </div>
        </div>
        {metadata.selection ? (
          <div className="text-muted-foreground mt-2 line-clamp-3 text-xs">
            &ldquo;{metadata.selection}&rdquo;
          </div>
        ) : null}
      </div>

      <Button
        className="w-full"
        disabled={!canSave}
        loading={saveState.type === "saving"}
        onClick={handleSave}
      >
        Save to matter
      </Button>

      {saveState.type === "success" ? (
        <p className="text-success mt-2 text-[13px]">Saved.</p>
      ) : null}
      {saveState.type === "queued" ? (
        <p className="text-success mt-2 text-[13px]">
          Offline; queued for sync.
        </p>
      ) : null}
      {saveState.type === "error" ? (
        <p className="text-destructive mt-2 text-[13px]">{saveState.message}</p>
      ) : null}
      {!activeMatter ? (
        <p className="text-destructive mt-2 text-[13px]">
          Select a matter to save clips.
        </p>
      ) : null}
    </section>
  );
};
