import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";

import { Separator } from "@stll/ui/separator";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import {
  CHATGPT_AUTH_CHANGED_EVENT,
  chatGptCommandError,
  isChatGptStatus,
} from "./chatgpt-status";
import type { ChatGptStatus } from "./chatgpt-status";
import { ChatGptCard } from "./ChatGptCard";
import type { ChatGptNotice } from "./ChatGptCard";
import {
  CLAUDE_CODE_AUTH_CHANGED_EVENT,
  isClaudeCodeStatus,
} from "./claude-code-status";
import type { ClaudeCodeStatus } from "./claude-code-status";
import { ClaudeCodeCard } from "./ClaudeCodeCard";
import {
  HARNESS_INSTALL_CHANGED_EVENT,
  harnessInstallState,
  isHarnessStatusList,
} from "./harness-install-status";
import type { HarnessStatus, ManagedHarness } from "./harness-install-status";
import { HarnessInstallLine } from "./HarnessInstallLine";

/**
 * AI subscriptions the local agents can use. It renders nothing unless the
 * local agents feature is on: the status commands refuse otherwise.
 */
export const AgentSubscriptionsSection = ({
  renderGroup,
}: {
  renderGroup: (content: React.JSX.Element) => React.JSX.Element;
}) => {
  const [chatGpt, refreshChatGpt] = useNativeStatus<ChatGptStatus>({
    read: readChatGptStatus,
    event: CHATGPT_AUTH_CHANGED_EVENT,
    isStatus: isChatGptStatus,
  });
  const [claudeCode, refreshClaudeCode] = useNativeStatus<ClaudeCodeStatus>({
    read: readClaudeCodeStatus,
    event: CLAUDE_CODE_AUTH_CHANGED_EVENT,
    isStatus: isClaudeCodeStatus,
  });
  const [harnesses, refreshHarnesses] = useNativeStatus<
    readonly HarnessStatus[]
  >({
    read: readHarnessStatus,
    event: HARNESS_INSTALL_CHANGED_EVENT,
    isStatus: isHarnessStatusList,
  });
  const [notice, setNotice] = useState<ChatGptNotice | null>(null);
  const [claudeCodeFailed, setClaudeCodeFailed] = useState(false);
  // Set before a start command is sent, so a second click in the same
  // frame cannot send another.
  const starting = useRef(false);
  const startingClaudeCode = useRef(false);

  if (chatGpt === null && claudeCode === null) {
    return null;
  }

  /** The CLI's install line; a refused command shows the card's notice. */
  const installLine = (
    harness: ManagedHarness,
    name: string,
    onFailed: () => void,
  ) => {
    const state = harnessInstallState(harnesses, harness);
    if (state === null) {
      return null;
    }
    const send = (command: () => Promise<unknown>) => {
      void Result.tryPromise(command).then((result) => {
        if (Result.isError(result)) {
          onFailed();
        }
        // Shown at once, without waiting for the change event.
        refreshHarnesses();
        return undefined;
      });
    };
    return (
      <HarnessInstallLine
        name={name}
        onCancel={(operationId) => {
          send(async () =>
            invoke("harness_cancel_install", { harness, operationId }),
          );
        }}
        onInstall={() => {
          send(async () => invoke("harness_install", { harness }));
        }}
        state={state}
      />
    );
  };

  const run = async (command: () => Promise<unknown>) => {
    setNotice(null);
    const result = await Result.tryPromise(command);
    if (Result.isError(result)) {
      setNotice("actionFailed");
      return null;
    }
    return result.value;
  };

  const runClaudeCode = async (command: () => Promise<unknown>) => {
    setClaudeCodeFailed(false);
    const result = await Result.tryPromise(command);
    if (Result.isError(result)) {
      setClaudeCodeFailed(true);
      return null;
    }
    return result.value;
  };

  const chatGptCard =
    chatGpt === null ? null : (
      <ChatGptCard
        install={installLine("codex", "Codex", () => {
          setNotice("actionFailed");
        })}
        notice={notice}
        onCancel={() => {
          void run(async () => invoke("chatgpt_auth_cancel"));
        }}
        onComplete={async (url) => {
          const result = await Result.tryPromise(async () =>
            invoke("chatgpt_auth_complete", { url }),
          );
          if (Result.isOk(result)) {
            setNotice(null);
            return true;
          }
          setNotice(
            chatGptCommandError(result.error) === "not_this_sign_in"
              ? "pasteRejected"
              : "actionFailed",
          );
          return false;
        }}
        onDisconnect={() => {
          void run(async () => invoke<unknown>("chatgpt_auth_disconnect")).then(
            (value) => {
              if (
                typeof value === "object" &&
                value !== null &&
                "revocationConfirmed" in value &&
                value.revocationConfirmed === false
              ) {
                setNotice("revocationUnconfirmed");
              }
              return undefined;
            },
          );
        }}
        onManageUsage={() => {
          void run(async () => invoke("chatgpt_auth_open_usage"));
        }}
        onSignIn={({ account, newAccount }) => {
          if (starting.current) {
            return;
          }
          starting.current = true;
          void run(async () =>
            invoke<unknown>("chatgpt_auth_start", {
              account: account ?? null,
              newAccount,
            }),
          ).then(() => {
            starting.current = false;
            // Shown at once, without waiting for the change event.
            refreshChatGpt();
            return undefined;
          });
        }}
        status={chatGpt}
      />
    );

  const claudeCodeCard =
    claudeCode === null ? null : (
      <ClaudeCodeCard
        actionFailed={claudeCodeFailed}
        install={installLine("claude-code", "Claude Code", () => {
          setClaudeCodeFailed(true);
        })}
        onCancel={() => {
          void runClaudeCode(async () => invoke("claude_code_auth_cancel"));
        }}
        onOpenSignInPage={() => {
          void runClaudeCode(async () =>
            invoke("claude_code_auth_open_sign_in_page"),
          );
        }}
        onSignIn={() => {
          if (startingClaudeCode.current) {
            return;
          }
          startingClaudeCode.current = true;
          void runClaudeCode(async () =>
            invoke<unknown>("claude_code_auth_start"),
          ).then(() => {
            startingClaudeCode.current = false;
            // Shown at once, without waiting for the change event.
            refreshClaudeCode();
            return undefined;
          });
        }}
        onSignOut={() => {
          void runClaudeCode(async () => invoke("claude_code_auth_sign_out"));
        }}
        status={claudeCode}
      />
    );

  return renderGroup(
    <>
      {chatGptCard}
      {chatGptCard && claudeCodeCard ? <Separator /> : null}
      {claudeCodeCard}
    </>,
  );
};

const readChatGptStatus = async () =>
  invoke<unknown>("chatgpt_auth_get_status");
const readClaudeCodeStatus = async () =>
  invoke<unknown>("claude_code_auth_get_status");
const readHarnessStatus = async () => invoke<unknown>("harness_get_status");

/**
 * A native status, read when its change event is live, again on every
 * change and whenever `refresh` is called. `null` while unread, refused
 * (the local agents feature is off) or malformed.
 */
export const useNativeStatus = <T,>({
  read,
  event,
  isStatus,
}: {
  read: () => Promise<unknown>;
  event: string;
  isStatus: (value: unknown) => value is T;
}) => {
  const [status, setStatus] = useState<T | null>(null);
  // The mounted effect's ordered read; a no-op outside it.
  const refreshLive = useRef<() => void>(() => undefined);
  useEffect(() => {
    let disposed = false;
    let latest = 0;
    const refresh = async () => {
      latest += 1;
      const current = latest;
      const result = await Result.tryPromise(read);
      if (disposed || current !== latest) {
        return;
      }
      setStatus(
        Result.isOk(result) && isStatus(result.value) ? result.value : null,
      );
    };
    refreshLive.current = () => {
      void refresh();
    };
    const stop = subscribeDesktopEvent<unknown>({
      event,
      handler: () => {
        void refresh();
      },
      onError: () => {
        setStatus(null);
      },
      onSubscribed: () => {
        void refresh();
      },
    });
    return () => {
      disposed = true;
      refreshLive.current = () => undefined;
      stop();
    };
  }, [read, event, isStatus]);
  // Reads again in order with the change events, so an older answer never
  // replaces a newer one.
  const refresh = () => {
    refreshLive.current();
  };
  return [status, refresh] as const;
};
