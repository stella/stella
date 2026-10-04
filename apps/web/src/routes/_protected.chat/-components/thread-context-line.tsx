import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";

import { InlinePill } from "@/components/inline-pill";
import {
  ReferenceChip,
  ReferenceIcon,
} from "@/components/references/reference-chip";
import type { ChatReference } from "@/components/references/reference.logic";
import type { ChatHistoryItem } from "@/features/chat/queries";
import { useFormatter } from "@/i18n/formatting-context";

import { layoutThreadContext } from "./thread-context-line.logic";

type ThreadContext = ChatHistoryItem["context"];
type ThreadContextMatter = ThreadContext["matters"][number];
type ThreadContextFile = ThreadContext["files"][number];

// Chips shrink with the row and truncate their label; the cap keeps one long
// name from taking the whole line from its neighbours. The column stretches
// the chip to the slot, so the chip's own label truncation applies.
const CHIP_SLOT_CLASS = "flex max-w-32 min-w-0 shrink flex-col";

const matterReference = (matter: ThreadContextMatter): ChatReference => ({
  type: "matter",
  matterId: matter.id,
  label: matter.name,
});

// The context carries the file's kind, so the chip draws it without a read;
// no matter is named, so the glyph keeps its neutral colour.
const fileReference = (file: ThreadContextFile): ChatReference => ({
  type: "entity",
  entityId: file.id,
  matterId: null,
  label: file.name,
  entityKind: file.kind,
  mimeType: file.mimeType,
});

/**
 * The quiet context line under a chat history title: the matters and files
 * the chat drew on, as mention-style chips. At most two of each show inline;
 * the rest fold into one "+N" badge whose hidden names screen readers still
 * hear. The line never wraps: chips truncate instead.
 */
export const ThreadContextLine = ({ context }: { context: ThreadContext }) => {
  const t = useTranslations();
  const format = useFormatter();
  const layout = layoutThreadContext(context);

  if (!layout.hasContext) {
    return null;
  }

  const hiddenNames = [
    ...layout.hidden.matters.map((matter) => matter.name),
    ...layout.hidden.files.map((file) => file.name),
    ...(layout.unnamedCount > 0
      ? [t("chat.historyContext.unnamed", { count: layout.unnamedCount })]
      : []),
  ];

  return (
    <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
      {layout.inline.matters.map((matter) => (
        <span className={CHIP_SLOT_CLASS} key={`matter-${matter.id}`}>
          <ReferenceChip
            interactive={false}
            reference={matterReference(matter)}
          />
        </span>
      ))}
      {layout.inline.files.map((file) => (
        <span className={CHIP_SLOT_CLASS} key={`file-${file.id}`}>
          <ReferenceChip interactive={false} reference={fileReference(file)} />
        </span>
      ))}
      {layout.overflowCount > 0 ? (
        <InlinePill className="shrink-0 tabular-nums">
          <span aria-hidden="true">
            {t("chat.historyContext.overflow", {
              count: layout.overflowCount,
            })}
          </span>
          <span className="sr-only">{format.list(hiddenNames)}</span>
        </InlinePill>
      ) : null}
    </span>
  );
};

/**
 * Everything the server named for a thread's context, for the tooltip the
 * history row's link owns (so keyboard focus opens it as hover does).
 */
export const ThreadContextTooltip = ({
  context,
}: {
  context: ThreadContext;
}) => {
  const t = useTranslations();
  const layout = layoutThreadContext(context);

  return (
    <div className="flex min-w-0 flex-col gap-2 py-1">
      {context.matters.length > 0 ? (
        <ThreadContextSection title={t("common.matters")}>
          {context.matters.map((matter) => (
            <ThreadContextEntry
              icon={<ReferenceIcon reference={matterReference(matter)} />}
              key={matter.id}
              name={matter.name}
            />
          ))}
        </ThreadContextSection>
      ) : null}
      {context.files.length > 0 ? (
        <ThreadContextSection title={t("common.files")}>
          {context.files.map((file) => (
            <ThreadContextEntry
              icon={<ReferenceIcon reference={fileReference(file)} />}
              key={file.id}
              name={file.name}
            />
          ))}
        </ThreadContextSection>
      ) : null}
      {layout.unnamedCount > 0 ? (
        <p className="text-muted-foreground">
          {t("chat.historyContext.unnamed", { count: layout.unnamedCount })}
        </p>
      ) : null}
    </div>
  );
};

const ThreadContextSection = ({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) => (
  <div className="flex min-w-0 flex-col gap-1">
    <p className="text-muted-foreground font-medium">{title}</p>
    <ul className="flex min-w-0 flex-col gap-1">{children}</ul>
  </div>
);

const ThreadContextEntry = ({
  icon,
  name,
}: {
  icon: ReactNode;
  name: string;
}) => (
  <li className="flex min-w-0 items-center gap-1.5">
    {icon}
    <BidiText as="span" className="min-w-0 truncate">
      {name}
    </BidiText>
  </li>
);
