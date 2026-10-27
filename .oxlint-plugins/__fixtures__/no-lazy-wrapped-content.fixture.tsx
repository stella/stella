// Passive regression fixture for
// `no-lazy-wrapped-content/no-lazy-wrapped-content`.
//
// Suppressed lines must be reported; otherwise the unused-directive check
// fails. Unsuppressed examples define the allowed boundary.

import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

type Decision = { id: string };

const Reader = (_props: { decision: Decision; gated?: boolean }) => <article />;
const Viewer = ({ children }: { children: ReactNode }) => (
  <section>{children}</section>
);
const Plain = ({ children }: { children: string }) => <p>{children}</p>;
const Skeleton = (_props: { rows: number }) => <div />;

const LazyMemberReader = lazy(async () => {
  const chunk = await import("./no-lazy-wrapped-content.chunks");
  return { default: chunk.MemberReader };
});
const LazyMemberChat = lazy(async () => {
  const chunk = await import("./no-lazy-wrapped-content.chunks");
  return { default: chunk.MemberChat };
});
const LazyMemberTools = lazy(async () => {
  const chunk = await import("./no-lazy-wrapped-content.chunks");
  return { default: chunk.MemberTools };
});
const LazyMarkdown = lazy(async () => {
  const chunk = await import("./no-lazy-wrapped-content.chunks");
  return { default: chunk.Markdown };
});

export const _fallbackDrawsTheReader = ({ decision }: { decision: Decision }) => (
  <Suspense
    // oxlint-disable-next-line no-lazy-wrapped-content/no-lazy-wrapped-content
    fallback={<Reader decision={decision} gated />}
  >
    <LazyMemberReader decision={decision} />
  </Suspense>
);

export const _lazyWrapsTheFallbackContent = ({
  children,
}: {
  children: ReactNode;
}) => (
  <Suspense
    // oxlint-disable-next-line no-lazy-wrapped-content/no-lazy-wrapped-content
    fallback={<Viewer>{children}</Viewer>}
  >
    {/* oxlint-disable-next-line no-lazy-wrapped-content/no-lazy-wrapped-content */}
    <LazyMemberChat>{children}</LazyMemberChat>
  </Suspense>
);

export const _lazyWrapsABranchContent = ({
  children,
  signedIn,
}: {
  children: ReactNode;
  signedIn: boolean;
}) => {
  if (!signedIn) {
    return <Viewer>{children}</Viewer>;
  }
  return (
    <Suspense fallback={null}>
      {/* oxlint-disable-next-line no-lazy-wrapped-content/no-lazy-wrapped-content */}
      <LazyMemberChat>{children}</LazyMemberChat>
    </Suspense>
  );
};

export const _toolsBesideTheReader = ({ decision }: { decision: Decision }) => (
  <>
    <Reader decision={decision} />
    {/* expect-clean: no-lazy-wrapped-content/no-lazy-wrapped-content */}
    <Suspense fallback={null}>
      <LazyMemberTools decisionId={decision.id} />
    </Suspense>
  </>
);

export const _placeholderSharesNoData = ({
  decision,
}: {
  decision: Decision;
}) => (
  <Suspense
    // expect-clean: no-lazy-wrapped-content/no-lazy-wrapped-content
    fallback={<Skeleton rows={3} />}
  >
    <LazyMemberReader decision={decision} />
  </Suspense>
);

export const _plainTextBeforeMarkdown = ({
  children,
  fallbackChildren,
}: {
  children: string;
  fallbackChildren?: string | undefined;
}) => (
  <Suspense
    // expect-clean: no-lazy-wrapped-content/no-lazy-wrapped-content
    fallback={<Plain>{fallbackChildren ?? children}</Plain>}
  >
    {/* expect-clean: no-lazy-wrapped-content/no-lazy-wrapped-content */}
    <LazyMarkdown>{children}</LazyMarkdown>
  </Suspense>
);

// A boundary that suspends on data, not on a lazy chunk, shows a lookalike.
export const _dataShellBeforeData = ({ decision }: { decision: Decision }) => (
  <Suspense
    // expect-clean: no-lazy-wrapped-content/no-lazy-wrapped-content
    fallback={<Reader decision={decision} gated />}
  >
    <Reader decision={decision} />
  </Suspense>
);
