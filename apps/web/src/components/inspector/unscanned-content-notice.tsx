import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import {
  type UnscannedContentReason,
  unscannedContentReasons,
} from "@stll/api-contract/file-scan-warnings";
import { AlertTriangleIcon } from "@stll/ui/icons";

import type { TranslationKey } from "@/i18n/types";

/** What the user is told about each kind of content the scan could not read. */
export const UNSCANNED_CONTENT_MESSAGE = {
  encrypted: "workspaces.files.unscannedContent.encrypted",
  unsupportedCompression:
    "workspaces.files.unscannedContent.unsupportedCompression",
} as const satisfies Record<UnscannedContentReason, TranslationKey>;

/**
 * The reasons a file field's stored scan warnings record, read from the
 * entity the inspector already holds; empty for any other field.
 */
export const fieldUnscannedContent = (
  entityData:
    | {
        fields: {
          id: string;
          content: { type: string; scanWarnings?: string[] | undefined };
        }[];
      }
    | undefined,
  fieldId: string,
): UnscannedContentReason[] => {
  const content = entityData?.fields.find(({ id }) => id === fieldId)?.content;
  return content?.type === "file"
    ? unscannedContentReasons(content.scanWarnings)
    : [];
};

/**
 * Says that part of a stored file, such as a password-protected file inside
 * a ZIP archive, was not scanned when it was uploaded.
 */
export const UnscannedContentNotice = ({
  reasons,
}: {
  reasons: readonly UnscannedContentReason[];
}) => {
  const t = useTranslations();
  if (reasons.length === 0) {
    return null;
  }
  return (
    <div
      className="bg-warning/10 text-warning-foreground flex shrink-0 flex-col gap-1 px-4 py-2 text-xs"
      role="status"
    >
      {reasons.map((reason) => (
        <p className="flex items-start gap-2" key={reason}>
          <AlertTriangleIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0"
          />
          {t(UNSCANNED_CONTENT_MESSAGE[reason])}
        </p>
      ))}
    </div>
  );
};

/** A file's viewer, with the notice above it when part of it was not scanned. */
export const WithUnscannedContentNotice = ({
  children,
  reasons,
}: {
  children: ReactNode;
  reasons: readonly UnscannedContentReason[];
}) =>
  reasons.length === 0 ? (
    children
  ) : (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <UnscannedContentNotice reasons={reasons} />
      {children}
    </div>
  );
