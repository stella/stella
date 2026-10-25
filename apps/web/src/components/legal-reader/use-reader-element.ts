import { useRef, useState } from "react";

/** Keep imperative reader refs and node-bound subscriptions on the same element. */
export const useReaderElement = <T extends HTMLElement>() => {
  const readerRef = useRef<T | null>(null);
  const [element, setElement] = useState<T | null>(null);
  const attach = (node: T | null) => {
    readerRef.current = node;
    setElement(node);
  };
  return { element, attach, readerRef };
};
