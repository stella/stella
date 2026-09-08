const mode = new URLSearchParams(globalThis.location.search).get("mode");

if (mode === "native") {
  const nativeTemporal = Object.freeze({ fixture: "native" });
  Object.defineProperty(globalThis, "Temporal", {
    configurable: true,
    value: nativeTemporal,
    writable: true,
  });
  const runtime = await import("temporal-polyfill/full");
  document.body.dataset.result =
    Object.is(runtime.Temporal, nativeTemporal) &&
    runtime.Intl === globalThis.Intl &&
    runtime.toTemporalInstant ===
      Reflect.get(Date.prototype, "toTemporalInstant")
      ? "native"
      : "unexpected";
} else {
  Object.defineProperty(globalThis, "Temporal", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  const runtime = await import("temporal-polyfill/full");
  const date = runtime.Temporal.PlainDate.from("2026-09-08")
    .withCalendar("hebrew")
    .withCalendar("iso8601")
    .toString();
  document.body.dataset.result =
    typeof runtime.Intl.DateTimeFormat === "function" &&
    typeof runtime.toTemporalInstant === "function"
      ? date
      : "unexpected";
}

export {};
