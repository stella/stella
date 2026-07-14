// Passive regression fixture for `no-ref-mirror/no-ref-mirror`.

import React, { useRef } from "react";

export function RefMirrorFixture({ value }: { value: string }) {
  const valueRef = useRef(value);
  // oxlint-disable-next-line no-ref-mirror/no-ref-mirror
  valueRef.current = value;

  const namespaceRef = React.useRef(value);
  // oxlint-disable-next-line no-ref-mirror/no-ref-mirror
  namespaceRef.current = value;

  const nestedRenderRef = useRef(value);
  if (value.length > 0) {
    // oxlint-disable-next-line no-ref-mirror/no-ref-mirror
    nestedRenderRef.current = value;
  }

  const domRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const updateLater = () => {
    valueRef.current = value;
    timerRef.current = window.setTimeout(() => undefined, 0);
  };

  return <div ref={domRef}>{updateLater.name}</div>;
}
