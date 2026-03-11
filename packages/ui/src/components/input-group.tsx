"use client";

import type * as React from "react";

import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

import { Input } from "@stella/ui/components/input";
import type { InputProps } from "@stella/ui/components/input";
import { Textarea } from "@stella/ui/components/textarea";
import type { TextareaProps } from "@stella/ui/components/textarea";
import { cn } from "@stella/ui/lib/utils";

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
    <div
      className={cn(
        "border-input bg-background text-foreground ring-ring/24 has-autofill:bg-foreground/4 has-[input:focus-visible,textarea:focus-visible]:border-ring has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/36 has-[input:focus-visible,textarea:focus-visible]:has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/64 has-[input:focus-visible,textarea:focus-visible]:has-[input[aria-invalid],textarea[aria-invalid]]:ring-destructive/16 dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-[input[aria-invalid],textarea[aria-invalid]]:ring-destructive/24 relative inline-flex w-full min-w-0 items-center rounded-lg border text-base shadow-xs/5 transition-shadow not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-[input:disabled,textarea:disabled]:not-has-[input:focus-visible,textarea:focus-visible]:not-has-[input[aria-invalid],textarea[aria-invalid]]:before:shadow-[0_1px_--theme(--color-black/4%)] has-data-[align=block-end]:h-auto has-data-[align=block-end]:flex-col has-data-[align=block-start]:h-auto has-data-[align=block-start]:flex-col has-[input:disabled,textarea:disabled]:opacity-64 has-[input:disabled,textarea:disabled,input:focus-visible,textarea:focus-visible,input[aria-invalid],textarea[aria-invalid]]:shadow-none has-[input:focus-visible,textarea:focus-visible]:ring-[3px] has-[textarea]:h-auto sm:text-sm dark:not-has-[input:disabled,textarea:disabled]:not-has-[input:focus-visible,textarea:focus-visible]:not-has-[input[aria-invalid],textarea[aria-invalid]]:before:shadow-[0_-1px_--theme(--color-white/6%)] has-data-[align=inline-end]:**:[[data-size=sm]_input]:pe-1.5 has-data-[align=inline-start]:**:[[data-size=sm]_input]:ps-1.5 *:[[data-slot=input-control],[data-slot=textarea-control]]:contents *:[[data-slot=input-control],[data-slot=textarea-control]]:before:hidden has-data-[align=block-end]:**:[input]:pt-1.5 has-data-[align=block-start]:**:[input]:pb-1.5 has-data-[align=inline-end]:**:[input]:pe-2 has-data-[align=inline-start]:**:[input]:ps-2 has-[[data-align=block-start],[data-align=block-end]]:**:[input]:h-auto **:[textarea_button]:rounded-[calc(var(--radius-md)-1px)] **:[textarea]:min-h-20.5 **:[textarea]:resize-none **:[textarea]:py-[calc(--spacing(3)-1px)] **:[textarea]:max-sm:min-h-23.5",
        className,
      )}
      data-slot="input-group"
      role="group"
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 leading-none select-none [&_svg]:-mx-0.5 in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&_svg:not([class*='size-'])]:size-4.5 sm:in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&_svg:not([class*='size-'])]:size-4 not-has-[button]:**:[svg:not([class*='opacity-'])]:opacity-80 [&>kbd]:rounded-[calc(var(--radius)-5px)]",
  {
    defaultVariants: {
      align: "inline-start",
    },
    variants: {
      align: {
        "block-end":
          "order-last w-full justify-start px-[calc(--spacing(3)-1px)] pb-[calc(--spacing(3)-1px)] [.border-t]:pt-[calc(--spacing(3)-1px)] [[data-size=sm]+&]:px-[calc(--spacing(2.5)-1px)]",
        "block-start":
          "order-first w-full justify-start px-[calc(--spacing(3)-1px)] pt-[calc(--spacing(3)-1px)] [.border-b]:pb-[calc(--spacing(3)-1px)] [[data-size=sm]+&]:px-[calc(--spacing(2.5)-1px)]",
        "inline-end":
          "order-last pe-[calc(--spacing(3)-1px)] has-[>:last-child[data-slot=badge]]:-me-1.5 has-[>button]:-me-2 has-[>kbd:last-child]:me-[-0.35rem] [[data-size=sm]+&]:pe-[calc(--spacing(2.5)-1px)]",
        "inline-start":
          "order-first ps-[calc(--spacing(3)-1px)] has-[>:last-child[data-slot=badge]]:-ms-1.5 has-[>button]:-ms-2 has-[>kbd:last-child]:ms-[-0.35rem] [[data-size=sm]+&]:ps-[calc(--spacing(2.5)-1px)]",
      },
    },
  },
);

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={cn(inputGroupAddonVariants({ align }), className)}
      data-align={align}
      data-slot="input-group-addon"
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        const isInteractive = target.closest(
          "button, a, input, select, textarea, [role='button'], [role='combobox'], [role='listbox'], [data-slot='select-trigger']",
        );
        if (isInteractive) {
          return;
        }
        e.preventDefault();
        const parent = e.currentTarget.parentElement;
        const input = parent?.querySelector<
          HTMLInputElement | HTMLTextAreaElement
        >("input, textarea");
        if (input && !parent?.querySelector("input:focus, textarea:focus")) {
          input.focus();
        }
      }}
      {...props}
    />
  );
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "text-muted-foreground line-clamp-1 flex items-center gap-2 leading-none [&_svg]:pointer-events-none [&_svg]:-mx-0.5 in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&_svg:not([class*='size-'])]:size-4.5 sm:in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: InputProps) {
  return <Input className={className} unstyled {...props} />;
}

function InputGroupTextarea({ className, ...props }: TextareaProps) {
  return <Textarea className={className} unstyled {...props} />;
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
};
