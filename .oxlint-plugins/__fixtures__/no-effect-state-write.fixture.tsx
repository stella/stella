import { startTransition, useReducer, useState } from "react";
import type { EffectCallback } from "react";

declare const useMountEffect: (effect: EffectCallback) => void;
declare const useExternalSyncEffect: (
  effect: EffectCallback,
  deps: readonly unknown[],
) => void;

export const WritesInEffectBodies = ({ value }: { value: number }) => {
  const [, setCopy] = useState(value);
  const [, dispatch] = useReducer((count: number) => count + 1, 0);
  useExternalSyncEffect(() => {
    // oxlint-disable-next-line no-effect-state-write/no-effect-state-write -- detector fixture: a write in the effect body re-renders and can re-run the effect
    setCopy(value);
  }, [value]);
  useMountEffect(() => {
    // oxlint-disable-next-line no-effect-state-write/no-effect-state-write -- detector fixture: a dispatch in a mount effect is a write in the effect body
    dispatch();
  });
  useExternalSyncEffect(() => {
    startTransition(() => {
      // oxlint-disable-next-line no-effect-state-write/no-effect-state-write -- detector fixture: startTransition runs its callback inside the effect
      setCopy(value);
    });
    return () => {
      // oxlint-disable-next-line no-effect-state-write/no-effect-state-write -- detector fixture: the cleanup runs on every dependency change
      setCopy(0);
    };
  }, [value]);
  return null;
};

export const WritesFromExternalCallbacks = ({ value }: { value: number }) => {
  const [, setWidth] = useState(0);
  useExternalSyncEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // expect-clean: no-effect-state-write/no-effect-state-write
        setWidth(entry.contentRect.width);
      }
    });
    const timer = setTimeout(() => {
      setWidth(value);
    }, 100);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [value]);
  return null;
};
