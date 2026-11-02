import { useRef, useState } from "react";

import { Result } from "better-result";
import { randomUUID } from "expo-crypto";
import { getDocumentAsync } from "expo-document-picker";
import { useFormatter, useTranslations } from "use-intl";

import { epochMilliseconds } from "@/connection/clock";
import { fetchWithTimeout } from "@/connection/http";
import { buildPdf, discardScans, scanPages } from "@/native/document-scanner";
import {
  admitPickedFiles,
  CHAT_FILE_PICKER_TYPES,
  readAttachment,
} from "@/state/chat-attachments";
import type {
  AttachmentRefusal,
  ChatAttachment,
  PickedFile,
} from "@/state/chat-attachments";
import { pdfName } from "@/state/scan-pages";

/** What the composer says about the files when something went wrong. */
export type AttachmentNotice =
  | AttachmentRefusal
  | "read-failed"
  | "pick-failed"
  | "scan-failed"
  | "pdf-failed";

/** Reading a file the picker copied must not leave the chip spinning. */
const READ_TIMEOUT_MS = 60_000;

/**
 * The files in the composer and the ways to add them: the system document
 * picker, or the document camera, whose pages go in as one PDF. Each file is
 * read into the data URL the message sends it as as soon as it is added, so
 * the send waits only on the network. What went wrong is kept as `notice`
 * until the next change.
 */
export const useChatAttachments = () => {
  const scanT = useTranslations("scan");
  const format = useFormatter();
  const [attachments, setAttachments] = useState<readonly ChatAttachment[]>([]);
  const [notice, setNotice] = useState<AttachmentNotice | undefined>(undefined);
  // Picking and reading finish after renders the closure has not seen.
  const latest = useRef<readonly ChatAttachment[]>([]);

  const update = (next: readonly ChatAttachment[]) => {
    latest.current = next;
    setAttachments(next);
  };

  const read = async (attachment: ChatAttachment) => {
    const result = await readDataUrl(attachment.uri);
    if (!latest.current.some(({ id }) => id === attachment.id)) {
      // Removed while it was being read.
      return;
    }
    const outcome = readAttachment(attachment, result);
    if (typeof outcome === "string") {
      update(latest.current.filter(({ id }) => id !== attachment.id));
      setNotice(outcome);
      return;
    }
    update(
      latest.current.map((shown) =>
        shown.id === outcome.id ? outcome : shown,
      ),
    );
    if (outcome.state.status === "failed") {
      setNotice("read-failed");
    }
  };

  const add = async (picked: readonly PickedFile[]) => {
    const { added, refused } = admitPickedFiles({
      current: latest.current,
      newId: randomUUID,
      picked,
    });
    setNotice(refused);
    update([...latest.current, ...added]);
    await Promise.all(added.map(read));
  };

  const pickDocument = () => {
    void (async () => {
      const picked = await Result.tryPromise(
        async () =>
          await getDocumentAsync({
            type: [...CHAT_FILE_PICKER_TYPES],
            copyToCacheDirectory: true,
            multiple: true,
          }),
      );
      if (Result.isError(picked)) {
        setNotice("pick-failed");
        return;
      }
      if (picked.value.canceled) {
        return;
      }
      await add(picked.value.assets);
    })();
  };

  const scanDocument = () => {
    void (async () => {
      // The scan's pages and PDF go into a folder of their own, removed once
      // the PDF is read into the message.
      const review = randomUUID();
      const scanned = await scanPages(review);
      if (Result.isError(scanned)) {
        setNotice("scan-failed");
        return;
      }
      if (scanned.value === null) {
        return;
      }
      const name = pdfName(
        scanT("defaultName", {
          day: format.dateTime(epochMilliseconds(), {
            day: "numeric",
            month: "short",
            year: "numeric",
          }),
        }),
        scanT("title"),
      );
      const built = await buildPdf(
        review,
        name,
        scanned.value.map(({ uri }) => ({ uri, rotation: 0 })),
      );
      if (Result.isError(built)) {
        discardScans(review);
        setNotice("pdf-failed");
        return;
      }
      await add([
        {
          uri: built.value.uri,
          name,
          mimeType: "application/pdf",
          size: built.value.size,
        },
      ]);
      discardScans(review);
    })();
  };

  return {
    attachments,
    notice,
    pickDocument,
    scanDocument,
    remove: (id: string) => {
      setNotice(undefined);
      update(latest.current.filter((attachment) => attachment.id !== id));
    },
    /** Empties the composer once a message took its files. */
    clear: () => {
      setNotice(undefined);
      update([]);
    },
    /** Hands back files the server never took, unless others were added since. */
    restore: (files: readonly ChatAttachment[]) => {
      if (latest.current.length === 0) {
        update(files);
      }
    },
  };
};

/**
 * A file on the phone as a data URL, or undefined when it could not be
 * read. The platform reader names whatever type the file system guessed;
 * `readAttachment` puts the chat type in its place.
 */
async function readDataUrl(uri: string): Promise<string | undefined> {
  const read = await Result.tryPromise(async () => {
    const blob = await (
      await fetchWithTimeout(fetch, uri, {}, READ_TIMEOUT_MS)
    ).blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("error", () => {
        reject(reader.error ?? new Error("The file could not be read"));
      });
      reader.addEventListener("load", () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
        } else {
          reject(new Error("The file reader returned no text"));
        }
      });
      reader.readAsDataURL(blob);
    });
  });
  return Result.isOk(read) ? read.value : undefined;
}
