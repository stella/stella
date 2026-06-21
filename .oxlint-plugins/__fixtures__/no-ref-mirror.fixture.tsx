// Passive regression fixture for `no-ref-mirror/no-ref-mirror`.

import React, { useRef } from "react";

export function RefMirrorFixture({ value }: { value: string }) {
  const valueRef = useRef(value);
  // oxlint-disable-next-line no-ref-mirror/no-ref-mirror
  valueRef.current = value;

  const namespaceRef = React.useRef(value);
  // oxlint-disable-next-line no-ref-mirror/no-ref-mirror
  namespaceRef.current = value;

  const domRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const updateLater = () => {
    valueRef.current = value;
    timerRef.current = window.setTimeout(() => undefined);
  };

  return <div ref={domRef}>{updateLater.name}</div>;
}
