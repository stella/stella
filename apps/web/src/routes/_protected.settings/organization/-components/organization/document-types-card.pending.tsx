import type { ComponentProps, ReactNode } from "react";

import { ButtonFace, InputFace } from "@stll/ui/control-face";
import { EllipsisIcon, GripVerticalIcon, PlusIcon } from "@stll/ui/icons";
import { InlineSkeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

const ROW_KEYS = ["first", "second", "third"];

export function DocumentTypesCardShell({
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <div className="flex flex-col gap-6" {...props}>
      {children}
    </div>
  );
}

export function DocumentTypeRows({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col gap-2">{children}</ul>;
}

export function DocumentTypeRowFace({
  className,
  dropTarget = false,
  ...props
}: ComponentProps<"li"> & { dropTarget?: boolean }) {
  return (
    <li
      className={cn(
        "bg-card flex items-center gap-2 rounded-lg border px-2 py-1.5",
        dropTarget && "ring-primary ring-2",
        className,
      )}
      {...props}
    />
  );
}

export function DocumentTypesCardPending() {
  return (
    <DocumentTypesCardShell aria-busy="true">
      <DocumentTypeRows>
        {ROW_KEYS.map((key) => (
          <DocumentTypeRowFace aria-hidden="true" key={key}>
            <ButtonFace size="icon-xs" variant="ghost">
              <GripVerticalIcon />
            </ButtonFace>
            <span className="flex h-8 flex-1 items-center px-3">
              <InlineSkeleton className="h-3.5 w-32" />
            </span>
            <ButtonFace size="icon-xs" variant="ghost">
              <EllipsisIcon />
            </ButtonFace>
          </DocumentTypeRowFace>
        ))}
      </DocumentTypeRows>
      <div className="flex w-full items-center gap-2">
        <InputFace>
          <PendingText
            barClassName="w-32"
            id="settings.organization.documentTypes.addPlaceholder"
          />
        </InputFace>
        <ButtonFace size="default" variant="default">
          <PlusIcon />
          <PendingText barClassName="w-6" id="common.add" />
        </ButtonFace>
      </div>
    </DocumentTypesCardShell>
  );
}
