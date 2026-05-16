import { useCallback, useRef, useState } from "react";

import { AlertTriangleIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { cn } from "@stll/ui/lib/utils";

const DELIMITERS = /[,;\n\t]/;

const getDomain = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

const hasWhitespace = (value: string) => {
  for (const char of value) {
    if (char.trim() === "") {
      return true;
    }
  }
  return false;
};

const isValidEmail = (value: string) => {
  const atIndex = value.indexOf("@");
  if (
    atIndex <= 0 ||
    atIndex !== value.lastIndexOf("@") ||
    atIndex === value.length - 1 ||
    hasWhitespace(value)
  ) {
    return false;
  }

  const domain = value.slice(atIndex + 1);
  const dotIndex = domain.indexOf(".");
  return dotIndex > 0 && dotIndex < domain.length - 1;
};

type ParsedInviteEmails = {
  valid: string[];
  invalid: string[];
};

const parseInviteEmails = (
  raw: string,
  existingEmails: readonly string[],
): ParsedInviteEmails => {
  const tokens = raw.split(DELIMITERS).flatMap((s) => {
    const trimmed = s.trim();
    return trimmed ? [trimmed] : [];
  });

  const valid: string[] = [];
  const invalid: string[] = [];
  const existingEmailSet = new Set(existingEmails);
  const validEmailSet = new Set<string>();

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (!isValidEmail(lower)) {
      invalid.push(token);
      continue;
    }

    if (existingEmailSet.has(lower) || validEmailSet.has(lower)) {
      continue;
    }

    valid.push(lower);
    validEmailSet.add(lower);
  }

  return { valid, invalid };
};

type InviteStepProps = {
  userEmail: string;
  onNext: (data: { emails: string[] }) => void;
  onEmailCountChange?: (count: number) => void;
};

export const InviteStep = ({
  userEmail,
  onNext,
  onEmailCountChange,
}: InviteStepProps) => {
  const userDomain = getDomain(userEmail);
  const t = useTranslations();
  const [emails, setEmails] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const processInput = useCallback(
    (raw: string) => {
      const { valid, invalid } = parseInviteEmails(raw, emails);

      if (valid.length > 0) {
        setEmails((prev) => {
          const next = [...prev, ...valid];
          onEmailCountChange?.(next.length);
          return next;
        });
      }

      if (invalid.length > 0) {
        setError(
          t("onboarding.inviteInvalidEmail", {
            value: invalid.join(", "),
          }),
        );
        setInput(invalid.join(", "));
        // Flash the input
        const el = inputRef.current;
        if (el) {
          el.classList.add("ring-2", "ring-destructive");
          setTimeout(() => {
            el.classList.remove("ring-2", "ring-destructive");
          }, 600);
        }
      } else {
        setError("");
        setInput("");
      }
    },
    [emails, t, onEmailCountChange],
  );

  const removeEmail = (email: string) => {
    setEmails((prev) => {
      const next = prev.filter((e) => e !== email);
      onEmailCountChange?.(next.length);
      return next;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      e.preventDefault();
      if (input.trim()) {
        processInput(input);
      }
    }
    if (e.key === "Backspace" && input === "" && emails.length > 0) {
      setEmails((prev) => {
        const next = prev.slice(0, -1);
        onEmailCountChange?.(next.length);
        return next;
      });
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    processInput(e.clipboardData.getData("text"));
  };

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.inviteTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.inviteSubtitle")}
      </p>

      <div className="mt-8 flex flex-col gap-3">
        {/* Email chips */}
        {emails.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {emails.map((email) => {
              const isExternal =
                userDomain.length > 0 && getDomain(email) !== userDomain;
              return (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm",
                    isExternal
                      ? "bg-warning/10 text-warning-foreground border-warning/20 border"
                      : "bg-accent text-foreground",
                  )}
                  key={email}
                >
                  {isExternal && (
                    <AlertTriangleIcon className="size-3 shrink-0 text-amber-500" />
                  )}
                  {email}
                  <button
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => removeEmail(email)}
                    type="button"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              );
            })}
            {userDomain.length > 0 &&
              emails.some((e) => getDomain(e) !== userDomain) && (
                <p className="text-xs text-amber-500">
                  <AlertTriangleIcon className="me-1 inline size-3" />
                  {t("onboarding.inviteExternal")}
                </p>
              )}
          </div>
        )}

        <Input
          autoFocus
          onChange={(e) => {
            setInput(e.target.value);
            if (error) {
              setError("");
            }
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="colleague@example.com"
          ref={inputRef}
          value={input}
        />
        {error ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : (
          <p className="text-foreground-subtle text-xs">
            {t("onboarding.inviteHint")}
          </p>
        )}
      </div>

      <div className="mt-8 flex items-center justify-end gap-3">
        <Button
          onClick={() => onNext({ emails: [] })}
          type="button"
          variant="ghost"
        >
          {t("onboarding.skipStep")}
        </Button>
        <Button
          onClick={() => {
            let finalEmails = emails;
            if (input.trim()) {
              const { valid, invalid } = parseInviteEmails(input, emails);
              processInput(input);
              if (invalid.length > 0) {
                return;
              }
              // Compute final list synchronously since
              // setEmails is async and won't update yet
              finalEmails = [...emails, ...valid];
            }
            onNext({ emails: finalEmails });
          }}
          type="button"
        >
          {t("common.next")}
        </Button>
      </div>
    </>
  );
};
