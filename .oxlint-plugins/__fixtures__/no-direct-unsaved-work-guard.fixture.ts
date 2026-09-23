// Passive regression fixture for
// `no-direct-unsaved-work-guard/no-direct-unsaved-work-guard`.
//
// Each `oxlint-disable-next-line` below suppresses a construct the rule MUST
// flag; if the rule regresses, the directive goes unused and the fixture lint
// fails. The trailing cases carry no directive, so over-firing fails too.

// oxlint-disable-next-line no-direct-unsaved-work-guard/no-direct-unsaved-work-guard
import { Link, useBlocker as useRouteBlocker } from "@tanstack/react-router";
import * as Router from "@tanstack/react-router";

declare const target: EventTarget;
const onUnload = (event: Event) => event.preventDefault();

export const useFixture = () => {
  useRouteBlocker({ shouldBlockFn: () => true });

  // Namespace access — MUST flag.
  // oxlint-disable-next-line no-direct-unsaved-work-guard/no-direct-unsaved-work-guard
  Router.useBlocker({ shouldBlockFn: () => true });

  // Listener on any target — MUST flag.
  // oxlint-disable-next-line no-direct-unsaved-work-guard/no-direct-unsaved-work-guard
  window.addEventListener("beforeunload", onUnload);

  // Template-literal event name — MUST flag.
  // oxlint-disable-next-line no-direct-unsaved-work-guard/no-direct-unsaved-work-guard
  target.addEventListener(`beforeunload`, onUnload);

  // --- Cases the rule MUST NOT flag ---
  window.addEventListener("pagehide", onUnload);
  // expect-clean: no-direct-unsaved-work-guard/no-direct-unsaved-work-guard
  window.removeEventListener("beforeunload", onUnload);
  return [Link, Router.useRouter];
};
