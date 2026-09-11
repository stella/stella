import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { invoke } from "@tauri-apps/api/core";
import {
  Building2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  EllipsisVerticalIcon,
  SearchIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type {
  DesktopRegistryConfig,
  DesktopRegistrySearchResponse,
} from "@stll/api-contract/desktop-registry";
import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";

const SEARCH_DEBOUNCE_MS = 300;

type Connection =
  | { status: "disconnected" }
  | ({ status: "connected" } & DesktopRegistryConfig);
type ResultCard = DesktopRegistrySearchResponse["results"][number] & {
  formatId: string | null;
  status: "ready" | "formatting";
};
type SearchState =
  | { status: "idle" }
  | { status: "loading"; scope: string }
  | {
      status: "ready";
      scope: string;
      results: ResultCard[];
      formats: DesktopRegistrySearchResponse["formats"];
    };

type RegistrySearchProps = {
  query: string;
  composing: boolean;
  source: "clips" | "registry";
  onSourceChange: (source: "clips" | "registry") => void;
  onFocusSearch: () => void;
  onConnectionFlowChange: (flow: "signIn" | "idle") => void;
  children: (slots: {
    controls: ReactNode;
    results: ReactNode;
    feedback: ReactNode;
  }) => ReactElement;
};

// This surface receives only the text typed in the search field. Clipboard
// history remains owned by ClipboardApp and is never a registry request input.
export const RegistrySearch = ({
  query,
  composing,
  source,
  onSourceChange,
  onFocusSearch,
  onConnectionFlowChange,
  children,
}: RegistrySearchProps) => {
  const t = useTranslations("clipboard");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [registryId, setRegistryId] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({
    status: "idle",
  });
  const [failure, setFailure] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const [connectionFailure, setConnectionFailure] = useState<string | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const connectionGeneration = useRef(0);
  const rail = useRef<HTMLDivElement>(null);
  const formatRequests = useRef(new Map<string, number>());
  const connectionError = t("registryErrorState");
  const searchError = t("registryErrorSearch");
  const connected = connection?.status === "connected";
  const trimmedQuery = query.trim();
  const scope = JSON.stringify([
    source,
    registryId,
    trimmedQuery,
    composing,
    attempt,
  ]);
  const error = failure?.scope === scope ? failure.message : connectionFailure;
  const setError = (message: string | null) =>
    setFailure(message === null ? null : { scope, message });

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      const request = ++connectionGeneration.current;
      generation.current += 1;
      void invoke<Connection>("registry_get_state")
        .then((resolved) => {
          if (disposed || request !== connectionGeneration.current) {
            return;
          }
          setConnection(resolved);
          setRegistryId((current) => {
            if (resolved.status === "disconnected") {
              return "";
            }
            if (resolved.registries.some(({ id }) => id === current)) {
              return current;
            }
            return (
              resolved.defaultRegistryId ??
              (resolved.registries.length === 1
                ? (resolved.registries.at(0)?.id ?? "")
                : "")
            );
          });
          setConnectionFailure(null);
          setAttempt((current) => current + 1);
          return;
        })
        .catch(() => {
          if (disposed || request !== connectionGeneration.current) {
            return;
          }
          setConnection({ status: "disconnected" });
          setConnectionFailure(connectionError);
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      generation.current += 1;
      window.removeEventListener("focus", refresh);
    };
  }, [connectionError]);

  useEffect(() => {
    const request = ++generation.current;
    formatRequests.current.clear();
    if (
      source !== "registry" ||
      !connected ||
      !registryId ||
      !trimmedQuery ||
      composing
    ) {
      return () => {
        generation.current += 1;
      };
    }
    const timer = setTimeout(() => {
      setSearchState({
        status: "loading",
        scope,
      });
      setFailure(null);
      void invoke<DesktopRegistrySearchResponse>("registry_search", {
        registry: registryId,
        query: trimmedQuery,
      })
        .then((response) => {
          if (generation.current !== request) {
            return;
          }
          setSearchState({
            status: "ready",
            scope,
            formats: response.formats,
            results: response.results.map((result) => ({
              ...result,
              formatId: response.defaultFormatId,
              status: "ready",
            })),
          });
          return;
        })
        .catch(() => {
          if (generation.current !== request) {
            return;
          }
          setSearchState({ status: "idle" });
          setFailure({ scope, message: searchError });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      generation.current += 1;
    };
  }, [
    source,
    connected,
    registryId,
    trimmedQuery,
    composing,
    scope,
    searchError,
  ]);

  const currentSearch =
    searchState.status !== "idle" && searchState.scope === scope && !composing
      ? searchState
      : ({ status: "idle" } as const);
  const connect = () => {
    generation.current += 1;
    setSearchState({ status: "idle" });
    setError(null);
    onConnectionFlowChange("signIn");
    void invoke("registry_connect").catch(() => {
      onConnectionFlowChange("idle");
      setError(t("registryErrorConnect"));
    });
  };
  const disconnect = () => {
    connectionGeneration.current += 1;
    generation.current += 1;
    setSearchState({ status: "idle" });
    void invoke("registry_disconnect")
      .then(() => {
        connectionGeneration.current += 1;
        setConnection({ status: "disconnected" });
        setRegistryId("");
        setError(null);
        return;
      })
      .catch(() => setError(t("registryErrorDisconnect")));
  };
  const copy = (card: ResultCard) => {
    if (card.status !== "ready" || currentSearch.status !== "ready") {
      return;
    }
    void invoke("registry_copy", { text: card.text }).catch(() =>
      setError(t("registryErrorCopy")),
    );
  };
  const format = (card: ResultCard, formatId: string | null) => {
    if (
      card.status !== "ready" ||
      card.formatId === formatId ||
      currentSearch.status !== "ready"
    ) {
      return;
    }
    const request = generation.current;
    const operation = (formatRequests.current.get(card.id) ?? 0) + 1;
    formatRequests.current.set(card.id, operation);
    setError(null);
    setSearchState((current) =>
      current.status === "ready"
        ? {
            ...current,
            results: current.results.map((result) =>
              result.id === card.id
                ? { ...result, status: "formatting" }
                : result,
            ),
          }
        : current,
    );
    void invoke<{ text: string }>("registry_format", {
      registry: registryId,
      id: card.id,
      formatId,
    })
      .then(({ text }) => {
        if (
          request !== generation.current ||
          formatRequests.current.get(card.id) !== operation
        ) {
          return;
        }
        setSearchState((current) =>
          current.status === "ready"
            ? {
                ...current,
                results: current.results.map((result) =>
                  result.id === card.id
                    ? { ...result, text, formatId, status: "ready" }
                    : result,
                ),
              }
            : current,
        );
        return;
      })
      .catch(() => {
        if (
          request !== generation.current ||
          formatRequests.current.get(card.id) !== operation
        ) {
          return;
        }
        setSearchState((current) =>
          current.status === "ready"
            ? {
                ...current,
                results: current.results.map((result) =>
                  result.id === card.id
                    ? { ...result, status: "ready" }
                    : result,
                ),
              }
            : current,
        );
        setError(t("registryErrorFormat"));
      });
  };

  let emptyText = t("registrySearchHint");
  if (connection === null) {
    emptyText = t("registryLoading");
  } else if (!connected) {
    emptyText = t("registryDisconnected");
  } else if (connection.registries.length === 0) {
    emptyText = t("registryUnavailable");
  } else if (!registryId) {
    emptyText = t("registrySelect");
  } else if (currentSearch.status === "loading") {
    emptyText = t("registrySearching");
  } else if (currentSearch.status === "ready") {
    emptyText = t("registryEmpty");
  }

  const controls = (
    <div
      role="group"
      aria-label={t("externalRegistry")}
      className="flex h-11 min-w-0 items-center gap-1"
      data-registry-controls
    >
      {source === "clips" ? (
        <Button
          className="h-11 max-w-64 min-w-0 justify-start text-xs"
          variant="ghost"
          data-registry-action
          disabled={!trimmedQuery || composing}
          onClick={() => onSourceChange("registry")}
        >
          <Building2Icon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">
            {trimmedQuery
              ? t("registrySearchAction", { query: trimmedQuery })
              : t("externalRegistry")}
          </span>
        </Button>
      ) : (
        <>
          <Button
            className="h-11 text-xs"
            variant="ghost"
            onClick={() => onSourceChange("clips")}
          >
            {t("allClips")}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  className="h-11 max-w-48 min-w-0 text-xs"
                  disabled={!connected || connection.registries.length === 0}
                />
              }
              aria-label={t("registrySelect")}
            >
              <Building2Icon aria-hidden="true" className="size-4" />
              <span className="truncate">
                {connected
                  ? (connection.registries.find(({ id }) => id === registryId)
                      ?.name ?? t("registrySelect"))
                  : t("registrySelect")}
              </span>
              <ChevronDownIcon aria-hidden="true" className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuRadioGroup value={registryId}>
                {connected
                  ? connection.registries.map(({ id, name }) => (
                      <MenuRadioItem
                        key={id}
                        value={id}
                        closeOnClick
                        onClick={() => setRegistryId(id)}
                      >
                        {name}
                      </MenuRadioItem>
                    ))
                  : null}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
          <Button
            variant="ghost"
            className="size-11 shrink-0"
            size="icon"
            aria-label={t("registrySearch")}
            disabled={!connected || !registryId || !trimmedQuery || composing}
            onClick={() => setAttempt((current) => current + 1)}
          >
            <SearchIcon aria-hidden="true" className="size-4" />
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  className="size-11 shrink-0"
                  variant="ghost"
                  size="icon"
                />
              }
              aria-label={t("moreOptions")}
            >
              <EllipsisVerticalIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={connect}>{t("registryConnect")}</MenuItem>
              {connected ? (
                <MenuItem onClick={disconnect}>
                  {t("registryDisconnect")}
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        </>
      )}
    </div>
  );
  const results = (
    <main
      aria-label={t("registrySearch")}
      className="relative min-h-0 flex-1"
      data-registry-results
    >
      {currentSearch.status === "ready" && currentSearch.results.length > 0 ? (
        <div
          role="group"
          aria-label={t("registrySearch")}
          ref={rail}
          className="absolute inset-0 flex scrollbar-none items-stretch gap-3 overflow-x-auto px-5 py-1"
        >
          {currentSearch.results.map((card) => (
            <article
              key={card.id}
              className="clipboard-card relative flex min-h-0 w-[246px] shrink-0 flex-col overflow-hidden rounded-2xl"
            >
              <button
                type="button"
                data-registry-card
                disabled={card.status === "formatting"}
                onKeyDown={(event) => {
                  if (
                    event.nativeEvent.isComposing ||
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.shiftKey ||
                    !(event.target instanceof HTMLButtonElement) ||
                    !Object.hasOwn(event.target.dataset, "registryCard")
                  ) {
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    onFocusSearch();
                    return;
                  }
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                    return;
                  }
                  event.preventDefault();
                  const cards = Array.from(
                    rail.current?.querySelectorAll<HTMLButtonElement>(
                      "[data-registry-card]:not(:disabled)",
                    ) ?? [],
                  );
                  const step =
                    (event.key === "ArrowRight" ? 1 : -1) *
                    (document.documentElement.dir === "rtl" ? -1 : 1);
                  cards
                    .at(
                      Math.max(
                        0,
                        Math.min(
                          cards.length - 1,
                          cards.indexOf(event.target) + step,
                        ),
                      ),
                    )
                    ?.focus();
                }}
                onClick={() => copy(card)}
                onFocus={(event) =>
                  event.currentTarget.scrollIntoView({
                    block: "nearest",
                    inline: "nearest",
                  })
                }
                className="focus-visible:ring-ring min-h-0 flex-1 overflow-y-auto px-4 py-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset"
              >
                <h2 className="truncate text-sm font-semibold" dir="auto">
                  {card.name}
                </h2>
                <p
                  className="text-foreground-muted mt-2 text-xs whitespace-pre-wrap"
                  dir="auto"
                >
                  {card.text}
                </p>
              </button>
              <footer className="clipboard-card-footer flex h-12 shrink-0 items-center px-2">
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        className="h-11 w-full justify-between text-xs"
                        variant="ghost"
                        disabled={card.status === "formatting"}
                      />
                    }
                    aria-label={t("registryFormat")}
                  >
                    <span className="truncate">
                      {currentSearch.formats.find(
                        ({ id }) => id === card.formatId,
                      )?.name ?? t("registryDefaultFormat")}
                    </span>
                    <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="start" side="top">
                    <MenuRadioGroup value={card.formatId ?? ""}>
                      <MenuRadioItem
                        value=""
                        closeOnClick
                        onClick={() => format(card, null)}
                      >
                        {t("registryDefaultFormat")}
                      </MenuRadioItem>
                      {currentSearch.formats.map(({ id, name }) => (
                        <MenuRadioItem
                          key={id}
                          value={id}
                          closeOnClick
                          onClick={() => format(card, id)}
                        >
                          {name}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="text-foreground-muted absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <p role="status" className="max-w-sm text-sm">
            {error ? "" : emptyText}
          </p>
          {connection?.status === "disconnected" ? (
            <Button className="min-h-11" variant="ghost" onClick={connect}>
              {t("registryConnect")}
            </Button>
          ) : null}
        </div>
      )}
    </main>
  );
  const feedback = (
    <div id="registry-error" className="min-w-0">
      {source === "registry" && error ? (
        <p
          className="text-foreground-muted flex min-w-0 items-center gap-1.5 text-xs"
          role="alert"
          aria-atomic="true"
        >
          <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate" title={error}>
            {error}
          </span>
        </p>
      ) : null}
    </div>
  );
  return children({ controls, results, feedback });
};
