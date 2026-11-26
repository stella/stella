import { useCallback, useReducer, useRef, useState } from "react";
import type { Ref } from "react";

declare const composeRefs: <T>(
  ...refs: (Ref<T> | undefined)[]
) => (node: T | null) => void;
declare const useComposedRefs: <T>(
  ...refs: (Ref<T> | undefined)[]
) => (node: T | null) => void;

export const WritesFromInlineRefs = () => {
  const [, setElement] = useState<HTMLDivElement | null>(null);
  const [, setWidth] = useState(0);
  const [, dispatch] = useReducer((count: number) => count + 1, 0);
  return (
    <>
      <div
        // oxlint-disable-next-line no-ref-callback-state-write/no-ref-callback-state-write -- detector fixture: the wrapper is new every render; pass the setter
        ref={(element) => setElement(element)}
      />
      <div
        // oxlint-disable-next-line no-ref-callback-state-write/no-ref-callback-state-write -- detector fixture: a measurement written from an inline ref re-renders into a new ref
        ref={(element) => {
          setWidth(element?.offsetWidth ?? 0);
        }}
      />
      <div
        // oxlint-disable-next-line no-ref-callback-state-write/no-ref-callback-state-write -- detector fixture: the returned cleanup writes on every re-attach
        ref={() => () => {
          dispatch();
        }}
      />
    </>
  );
};

export const WritesFromObserversAndHelpers = () => {
  const [, setWidth] = useState(0);
  const measure = (element: HTMLElement) => {
    setWidth(element.offsetWidth);
  };
  // oxlint-disable-next-line no-ref-callback-state-write/no-ref-callback-state-write -- detector fixture: a local helper the ref calls writes state
  const measureRef = (element: HTMLElement | null) => {
    if (element) {
      measure(element);
    }
  };
  const observeRef = useCallback(
    // oxlint-disable-next-line no-ref-callback-state-write/no-ref-callback-state-write -- detector fixture: the observer reports once after observe(), from a ref that re-attaches
    (element: HTMLElement | null) => {
      if (!element) {
        return undefined;
      }
      const observer = new ResizeObserver(() => {
        setWidth(element.offsetWidth);
      });
      observer.observe(element);
      return () => {
        observer.disconnect();
      };
    },
    [],
  );
  const composed = useComposedRefs(measureRef, observeRef);
  return <div ref={composed} />;
};

export const ComposesDuringRender = ({ forwarded }: { forwarded: Ref<HTMLDivElement> }) => {
  const local = useRef<HTMLDivElement>(null);
  return (
    // oxlint-disable-next-line no-ref-callback-state-write/no-ref-callback-state-write -- detector fixture: composeRefs during render is a new callback every render
    <div ref={composeRefs(local, forwarded)} />
  );
};

export const AllowedRefs = ({ forwarded }: { forwarded: Ref<HTMLDivElement> }) => {
  const [, setElement] = useState<HTMLDivElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const composed = useComposedRefs(forwarded, setElement);
  return (
    <>
      <div
        // expect-clean: no-ref-callback-state-write/no-ref-callback-state-write
        ref={setElement}
      />
      <div
        // expect-clean: no-ref-callback-state-write/no-ref-callback-state-write
        ref={composed}
      />
      <div
        // expect-clean: no-ref-callback-state-write/no-ref-callback-state-write
        ref={(element) => {
          element?.focus();
        }}
      />
      <div
        // expect-clean: no-ref-callback-state-write/no-ref-callback-state-write
        ref={(element) => {
          if (element) {
            nodes.current.set("row", element);
          }
          return () => {
            nodes.current.delete("row");
          };
        }}
      />
    </>
  );
};
