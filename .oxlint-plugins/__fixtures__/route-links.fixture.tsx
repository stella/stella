import { linkOptions } from "@tanstack/react-router";

declare const Thing: (props: Record<string, unknown>) => null;

// oxlint-disable-next-line route-links/detached-link-options -- Negative fixture: a conditional route link widens its destination.
export const Conditional = condition ? null : { to: "/law" };
// oxlint-disable-next-line route-links/detached-link-options -- Negative fixture: const assertion on an outer value does not reach a detached object.
export const OuterAssertion = { to: "/law" } as const;
// oxlint-disable-next-line route-links/detached-link-options -- Negative fixture: a bare array does not preserve route-link literals.
export const DetachedArray = [{ to: "/law" }];
// oxlint-disable-next-line route-links/detached-link-options -- Negative fixture: returned route objects are detached.
export const returned = () => ({ to: "/law" });
// oxlint-disable-next-line route-links/detached-link-options -- Negative fixture: nested route objects are detached.
export const nested = { link: { to: "/law" } };
// oxlint-disable-next-line route-links/detached-link-options -- Negative fixture: an object nested inside a call argument is detached.
export const nestedInCall = consume({ link: { to: "/law" } });
// oxlint-disable-next-line route-links/detached-link-options -- Negative fixture: a spread expression is not a JSX attribute value.
export const spread = <Thing {...{ to: "/law" }} />;

// expect-clean: route-links/detached-link-options
export const direct = navigate({ to: "/law" });
export const options = linkOptions({ to: "/law" });
export const arrayOptions = linkOptions([{ to: "/law" }]);
export const memberArrayOptions = router.linkOptions([{ to: "/law" }]);
export const jsx = <Thing route={{ to: "/law" }} />;
