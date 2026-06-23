// Passive regression fixture for
// `require-dir-on-rendered-name/require-dir-on-rendered-name`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag;
// a regression makes them unused and CI fails. Lines without a directive
// cover the allow-list and must keep passing.

import type { ReactNode } from "react";

declare const x: {
  displayName: string;
  fileName: string;
  name: string;
  client: { displayName: string };
};
declare const BidiText: (props: { children: ReactNode }) => ReactNode;
declare const UserText: (props: { children: ReactNode }) => ReactNode;

// --- Flagged: a bare user-content name property rendered without dir ---
export const _display = () => (
  // oxlint-disable-next-line require-dir-on-rendered-name/require-dir-on-rendered-name
  <span>{x.displayName}</span>
);
export const _nested = () => (
  // oxlint-disable-next-line require-dir-on-rendered-name/require-dir-on-rendered-name
  <div>{x.client.displayName}</div>
);
export const _file = () => (
  // oxlint-disable-next-line require-dir-on-rendered-name/require-dir-on-rendered-name
  <span>{x.fileName}</span>
);
export const _nameWithSibling = () => (
  <span>
    {/* oxlint-disable-next-line require-dir-on-rendered-name/require-dir-on-rendered-name */}
    {x.displayName} <small>(archived)</small>
  </span>
);

// --- Allowed: dir present, <bdi>, or a non-name expression ---
export const _ok1 = () => <span dir="auto">{x.displayName}</span>;
export const _ok2 = () => <bdi>{x.displayName}</bdi>;
export const _ok3 = () => <span>{x.name}</span>;
export const _ok4 = () => <BidiText>{x.displayName}</BidiText>;
export const _ok5 = () => <UserText>{x.fileName}</UserText>;
