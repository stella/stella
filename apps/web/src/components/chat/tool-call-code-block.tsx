import type { CSSProperties } from "react";

import { Result, panic } from "better-result";
import { Prism, useTokenize } from "prism-react-renderer";
import type { PrismTheme, Token } from "prism-react-renderer";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import { CopyIcon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";

const TOOL_CODE_THEME = {
  plain: {
    backgroundColor: "transparent",
    color: "var(--color-foreground)",
  },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: "var(--color-muted-foreground)", fontStyle: "italic" },
    },
    {
      types: ["punctuation"],
      style: { color: "var(--color-foreground-muted)" },
    },
    {
      types: ["keyword", "operator", "atrule"],
      style: { color: "var(--color-destructive)" },
    },
    {
      types: ["function", "class-name", "builtin"],
      style: { color: "var(--color-primary)" },
    },
    {
      types: ["string", "char", "attr-value"],
      style: { color: "var(--color-info)" },
    },
    {
      types: ["number", "boolean", "constant", "symbol"],
      style: { color: "var(--color-warning)" },
    },
    {
      types: ["property", "tag", "selector", "attr-name"],
      style: { color: "var(--color-success)" },
    },
  ],
} satisfies PrismTheme;

/**
 * `call` is what the agent sent (foreground); `result` is what came
 * back, rendered muted below it. No card chrome: the block sits flush
 * under the tool row, and `label` names it for assistive tech only.
 */
export type ToolCallCodeTone = "call" | "result";

export const ToolCallCodeBlock = ({
  code,
  label,
  language,
  lineNumbers,
  tone,
}: {
  code: string;
  label: string;
  language: "json" | "text" | "typescript";
  lineNumbers?: boolean;
  tone: ToolCallCodeTone;
}) => {
  const t = useTranslations();
  const shouldShowLineNumbers = lineNumbers ?? false;
  const tokens = useTokenize({ code, language, prism: Prism });
  const keyedLines = addStableKeys(tokens);

  const handleCopy = async () => {
    const copied = await copyToClipboard(code);
    if (Result.isError(copied)) {
      getAnalytics().captureError(copied.error);
      notifyUserError(copied.error, t("errors.actionFailed"));
      return;
    }
    stellaToast.add({ title: t("common.copied"), type: "success" });
  };

  return (
    <section aria-label={label} className="group/code relative">
      <div
        className="absolute end-1 top-1 opacity-0 transition-opacity duration-150 group-hover/code:opacity-100 focus-within:opacity-100"
        data-chat-copy-exclude
      >
        <Button
          aria-label={t("common.copy")}
          onClick={() => {
            detached(handleCopy(), "tool-call-code-block.copy");
          }}
          size="icon-xs"
          type="button"
          variant="muted"
        >
          <CopyIcon className="size-3.5" />
        </Button>
      </div>
      <pre
        className={cn(
          "max-h-96 overflow-auto py-1 pe-8 font-mono text-xs leading-5",
          getToneClassName(tone),
        )}
        style={TOOL_CODE_THEME.plain}
      >
        {keyedLines.map(({ key, lineNumber, tokens: lineTokens }) => (
          <span className="block" key={key}>
            {shouldShowLineNumbers && (
              <span
                className="text-foreground-ghost me-4 inline-block w-5 text-end tabular-nums select-none"
                data-chat-copy-exclude
              >
                {lineNumber}
              </span>
            )}
            {lineTokens.map(({ key: tokenKey, token }) => (
              <span key={tokenKey} style={getTokenStyle(token)}>
                {token.content}
              </span>
            ))}
          </span>
        ))}
      </pre>
    </section>
  );
};

const getToneClassName = (tone: ToolCallCodeTone): string | undefined => {
  switch (tone) {
    case "call":
      return undefined;
    case "result":
      return "opacity-60";
    default:
      tone satisfies never;
      return panic("Unhandled tool call code tone");
  }
};

const addStableKeys = (lines: Token[][]) => {
  const lineOccurrences = new Map<string, number>();
  let lineNumber = 0;

  return lines.map((line) => {
    lineNumber += 1;
    const lineSignature = line.map(getTokenSignature).join("|");
    const lineOccurrence = lineOccurrences.get(lineSignature) ?? 0;
    lineOccurrences.set(lineSignature, lineOccurrence + 1);
    const tokenOccurrences = new Map<string, number>();
    const keyedTokens = line.map((token) => {
      const signature = getTokenSignature(token);
      const occurrence = tokenOccurrences.get(signature) ?? 0;
      tokenOccurrences.set(signature, occurrence + 1);

      return { key: `${signature}:${occurrence}`, token };
    });

    return {
      key: `${lineSignature}:${lineOccurrence}`,
      line,
      lineNumber,
      tokens: keyedTokens,
    };
  });
};

const getTokenSignature = ({ content, types }: Token): string =>
  `${types.join(".")}:${content}`;

const getTokenStyle = ({ types }: Token) => {
  const style: CSSProperties = {};

  for (const themeEntry of TOOL_CODE_THEME.styles) {
    if (themeEntry.types.some((type) => types.includes(type))) {
      Object.assign(style, themeEntry.style);
    }
  }

  return style;
};
