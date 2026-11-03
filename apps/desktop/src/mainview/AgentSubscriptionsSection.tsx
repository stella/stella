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

const readChatGptStatus = async () =>
  invoke<unknown>("chatgpt_auth_get_status");
const readClaudeCodeStatus = async () =>
  invoke<unknown>("claude_code_auth_get_status");

/**
 * A native status, read when its change event is live and again on every
 * change. `null` while unread, refused (the local agents feature is off) or
 * malformed.
 */
const useNativeStatus = <T,>({
  read,
  event,
  isStatus,
}: {
  read: () => Promise<unknown>;
  event: string;
  isStatus: (value: unknown) => value is T;
}) => {
  const [status, setStatus] = useState<T | null>(null);
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
      stop();
    };
  }, [read, event, isStatus]);
  return [status, setStatus] as const;
};

/**
 * AI subscriptions the local agents can use. It renders nothing unless the
 * local agents feature is on: the status commands refuse otherwise.
 */
export const AgentSubscriptionsSection = ({
  renderGroup,
}: {
  renderGroup: (content: React.JSX.Element) => React.JSX.Element;
}) => {
  const [chatGpt, setChatGpt] = useNativeStatus<ChatGptStatus>({
    read: readChatGptStatus,
    event: CHATGPT_AUTH_CHANGED_EVENT,
    isStatus: isChatGptStatus,
  });
  const [claudeCode, setClaudeCode] = useNativeStatus<ClaudeCodeStatus>({
    read: readClaudeCodeStatus,
    event: CLAUDE_CODE_AUTH_CHANGED_EVENT,
    isStatus: isClaudeCodeStatus,
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
          ).then((started) => {
            starting.current = false;
            // Shown at once, without waiting for the change event.
            if (isChatGptStatus(started)) {
              setChatGpt(started);
            }
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
          ).then((started) => {
            startingClaudeCode.current = false;
            // Shown at once, without waiting for the change event.
            if (isClaudeCodeStatus(started)) {
              setClaudeCode(started);
            }
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
