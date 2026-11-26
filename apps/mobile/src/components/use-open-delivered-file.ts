import { useRef, useState } from "react";

import { Result } from "better-result";
import { Alert } from "react-native";
import { useTranslations } from "use-intl";

import { useMountEffect } from "@stll/ui/effects";

import {
  discardOpenedFile,
  downloadDocument,
  type OpenedFile,
} from "@/native/document-files";
import type { ApiError } from "@/state/api-request";
import { isOffline } from "@/state/document-file";

type DeliveredLink = Result<
  { readonly presignedUrl: string; readonly fileName: string },
  ApiError
>;

/**
 * Opens a file the server hands out as a short-lived link (the original, or
 * a part of it) in the system preview, one at a time. `opening` names the
 * file being fetched, so its control can show that it is busy.
 */
export const useOpenDeliveredFile = (
  showPreview: (file: OpenedFile) => Promise<void>,
) => {
  const t = useTranslations("document");
  const [opening, setOpening] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useMountEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  });

  // Each await can outlive the screen; read the ref afresh after every one.
  const isMounted = () => mounted.current;
  const open = async (key: string, read: () => Promise<DeliveredLink>) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setOpening(key);
    let opened: OpenedFile | null = null;
    try {
      const link = await read();
      if (!isMounted()) {
        return;
      }
      if (Result.isError(link)) {
        Alert.alert(
          t("failedTitle"),
          t(isOffline(link.error) ? "failure.offline" : "failure.failed"),
        );
        return;
      }
      const downloaded = await downloadDocument(
        link.value.presignedUrl,
        link.value.fileName,
      );
      if (Result.isOk(downloaded)) {
        opened = downloaded.value;
        if (isMounted()) {
          await showPreview(opened);
        }
      } else if (isMounted()) {
        Alert.alert(
          t("failedTitle"),
          t(downloaded.error.offline ? "failure.offline" : "failure.failed"),
        );
      }
    } finally {
      if (opened !== null) {
        discardOpenedFile(opened);
      }
      inFlight.current = false;
      if (isMounted()) {
        setOpening(null);
      }
    }
  };
  return { opening, open };
};
