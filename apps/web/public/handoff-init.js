// Capture before application modules or telemetry initialize. Keep the code
// in memory only, and remove every occurrence from the address immediately.
(() => {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const code = fragment.get("sh");
  if (!fragment.has("sh")) return;
  url.hash = url.hash
    .slice(1)
    .split("&")
    .filter((part) => !new URLSearchParams(part).has("sh"))
    .join("&");
  window.history.replaceState(window.history.state, "", url);
  let pending = code
    ? {
        code,
        path: url.pathname + url.search,
        destination: url.pathname + url.search + url.hash,
      }
    : undefined;
  window.hasStellaHandoff = () => pending !== undefined;
  window.takeStellaHandoff = () => {
    const captured = pending;
    pending = undefined;
    return captured;
  };
})();
