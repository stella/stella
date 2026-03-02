"use client";

import {
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type FormEventHandler,
  type HTMLAttributes,
  type KeyboardEventHandler,
} from "react";
import type { ChatStatus } from "ai";
import { CornerDownLeftIcon, LoaderIcon, SquareIcon } from "lucide-react";

import { Button } from "@stella/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@stella/ui/components/input-group";
import type { TextareaProps } from "@stella/ui/components/textarea";
import { cn } from "@stella/ui/lib/utils";

// ------------------------------------------------------------------
// PromptInput
// ------------------------------------------------------------------

export type PromptInputMessage = {
  text: string;
};

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit"
> & {
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};

export const PromptInput = ({
  className,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  const formRef = useRef<HTMLFormElement | null>(null);

  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const raw = formData.get("message");
      const text = typeof raw === "string" ? raw : "";
      if (!text.trim()) {
        return;
      }
      event.currentTarget.reset();
      onSubmit({ text }, event);
    },
    [onSubmit],
  );

  return (
    <form
      className={cn("w-full", className)}
      onSubmit={handleSubmit}
      ref={formRef}
      {...props}
    >
      <InputGroup className="overflow-hidden">{children}</InputGroup>
    </form>
  );
};

// ------------------------------------------------------------------
// PromptInputTextarea
// ------------------------------------------------------------------

export type PromptInputTextareaProps = TextareaProps;

export const PromptInputTextarea = ({
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) {
        return;
      }

      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) {
          return;
        }
        if (e.shiftKey) {
          return;
        }
        e.preventDefault();

        const { form } = e.currentTarget;
        const submitButton = form?.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        );
        if (submitButton?.disabled) {
          return;
        }

        form?.requestSubmit();
      }
    },
    [onKeyDown, isComposing],
  );

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      {...props}
    />
  );
};

// ------------------------------------------------------------------
// PromptInputFooter
// ------------------------------------------------------------------

export type PromptInputFooterProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputFooter = ({
  className,
  ...props
}: PromptInputFooterProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("justify-between gap-1", className)}
    {...props}
  />
);

// ------------------------------------------------------------------
// PromptInputSubmit
// ------------------------------------------------------------------

export type PromptInputSubmitProps = HTMLAttributes<HTMLButtonElement> & {
  status?: ChatStatus;
  onStop?: () => void;
};

export const PromptInputSubmit = ({
  className,
  status,
  onStop,
  ...props
}: PromptInputSubmitProps) => {
  const isGenerating = status === "submitted" || status === "streaming";

  let Icon = <CornerDownLeftIcon className="size-4" />;
  if (status === "submitted") {
    Icon = <LoaderIcon className="size-4 animate-spin" />;
  } else if (status === "streaming") {
    Icon = <SquareIcon className="size-4" />;
  }

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (isGenerating && onStop) {
        e.preventDefault();
        onStop();
      }
    },
    [isGenerating, onStop],
  );

  return (
    <Button
      aria-label={isGenerating ? "Stop" : "Submit"}
      className={cn(className)}
      onClick={handleClick}
      size="icon-sm"
      type={isGenerating && onStop ? "button" : "submit"}
      variant="default"
      {...props}
    >
      {Icon}
    </Button>
  );
};
