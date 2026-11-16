// The lazy chunks `no-lazy-wrapped-content.fixture.tsx` imports.

import type { ReactNode } from "react";

type Decision = { id: string };

export const MemberReader = (_props: { decision: Decision }) => <article />;

export const MemberChat = ({ children }: { children: ReactNode }) => (
  <div>{children}</div>
);

export const MemberTools = (_props: { decisionId: string }) => null;

export const Markdown = ({ children }: { children: string }) => (
  <p>{children}</p>
);
