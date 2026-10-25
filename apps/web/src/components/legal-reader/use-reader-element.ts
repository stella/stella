import { useCallback, useRef, useState } from "react";

/** Keep imperative reader refs and node-bound subscriptions on the same element. */
export const useReaderElement = <T extends HTMLElement>() => {
  const readerRef = useRef<T | null>(null);
  const [element, setElement] = useState<T | null>(null);
  const attach = useCallback(
    (node: T | null) => {
      readerRef.current = node;
      setElement(node);
    },
    [readerRef],
  );
  return { element, attach, readerRef };
};
