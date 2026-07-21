import type { CSSProperties } from "react";

import { CopyIcon } from "lucide-react";
import { Prism, useTokenize } from "prism-react-renderer";
import type { PrismTheme, Token } from "prism-react-renderer";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { detached } from "@/lib/detached";

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

export const ToolCallCodeBlock = ({
  code,
  language,
  lineNumbers,
}: {
  code: string;
  language: "json" | "text" | "typescript";
  lineNumbers?: boolean;
}) => {
  const t = useTranslations();
  const shouldShowLineNumbers = lineNumbers ?? false;
  const tokens = useTokenize({ code, language, prism: Prism });
  const keyedLines = addStableKeys(tokens);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      stellaToast.add({ title: t("common.copied"), type: "success" });
    } catch {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    }
  };

  return (
    <div className="bg-background/50 overflow-hidden rounded-lg border">
      <div className="text-muted-foreground flex h-9 items-center justify-between px-2.5 text-[11px]">
        <span className="font-mono lowercase">{language}</span>
        <Button
          aria-label={t("common.copy")}
          className="text-muted-foreground"
          onClick={() => {
            detached(handleCopy(), "ToolCallCodeBlock");
          }}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <CopyIcon className="size-3.5" />
        </Button>
      </div>
      <pre
        className="max-h-96 overflow-auto px-3 pb-3 font-mono text-xs leading-5"
        style={TOOL_CODE_THEME.plain}
      >
        {keyedLines.map(({ key, lineNumber, tokens: lineTokens }) => (
          <div key={key}>
            {shouldShowLineNumbers && (
              <span className="text-foreground-ghost me-4 inline-block w-5 text-end tabular-nums select-none">
                {lineNumber}
              </span>
            )}
            {lineTokens.map(({ key: tokenKey, token }) => (
              <span key={tokenKey} style={getTokenStyle(token)}>
                {token.content}
              </span>
            ))}
          </div>
        ))}
      </pre>
    </div>
  );
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
