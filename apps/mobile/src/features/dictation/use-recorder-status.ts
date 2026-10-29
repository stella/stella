import { useEffect } from "react";
import type { RefObject } from "react";

import { Result } from "better-result";
import { AppState } from "react-native";

import { epochMilliseconds } from "@/connection/clock";
import { METER_INTERVAL_MS } from "@/features/dictation/signal";
import type {
  DictationRecorder,
  NativeDraft,
} from "@/native/dictation-recorder";

type RecorderStatusOptions = {
  active: NativeDraft | null;
  busy: RefObject<boolean>;
  revision: RefObject<number>;
  status: DictationRecorder["status"];
  update: (draft: NativeDraft) => void;
  fail: (failed: boolean) => void;
  tick: (now: number) => void;
};

export const useRecorderStatus = ({
  active,
  busy,
  revision,
  status,
  update,
  fail,
  tick,
}: RecorderStatusOptions): void => {
  useEffect(() => {
    if (active?.status !== "recording") {
      return;
    }
    let mounted = true;
    let reading = false;
    let frame: number | undefined;
    const id = active.id;
    const interval = setInterval(() => {
      if (reading || busy.current || AppState.currentState !== "active") {
        return;
      }
      reading = true;
      const readRevision = revision.current;
      void Result.tryPromise(async () => await status(id)).then((result) => {
        reading = false;
        if (!mounted || readRevision !== revision.current) {
          return undefined;
        }
        frame = requestAnimationFrame(() => {
          if (!mounted || readRevision !== revision.current) {
            return undefined;
          }
          tick(epochMilliseconds());
          if (Result.isOk(result)) {
            update(result.value);
          } else {
            fail(true);
          }
          return undefined;
        });
        return undefined;
      });
    }, METER_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(interval);
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
    };
  }, [active?.id, active?.status, status, busy, revision, update, fail, tick]);
};
