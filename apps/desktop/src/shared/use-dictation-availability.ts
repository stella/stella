import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";

import { subscribeDesktopEvent } from "./desktop-events";

type DictationAvailability = "loading" | "available" | "unavailable";

const offersDictation = (snapshot: unknown): boolean =>
  typeof snapshot === "object" &&
  snapshot !== null &&
  "available" in snapshot &&
  snapshot.available === true;

/**
 * Whether this build and account offer dictation, which decides the
 * Dictation page and every way into it. Reads the snapshot again on every
 * dictation change, which the native side also sends when the server's
 * decision changes.
 */
export const useDictationAvailability = () => {
  const [availability, setAvailability] =
    useState<DictationAvailability>("loading");

  useEffect(() => {
    let disposed = false;
    let request = 0;
    const read = async () => {
      request += 1;
      const current = request;
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("dictation_get_snapshot"),
      );
      if (disposed || current !== request) {
        return;
      }
      setAvailability(
        Result.isOk(result) && offersDictation(result.value)
          ? "available"
          : "unavailable",
      );
    };
    const stopListening = subscribeDesktopEvent({
      event: "dictation-changed",
      handler: () => {
        void read();
      },
      onError: () => {
        setAvailability("unavailable");
      },
    });
    void read();
    return () => {
      disposed = true;
      stopListening();
    };
  }, []);

  return availability;
};
