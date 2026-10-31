import * as ReactNamespace from "react";
import { useCallback, useMemo as memoize } from "react";

export const Memoized = ({ rows }: { rows: string[] }) => {
  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- fixture: the compiler caches the derived list
  const sorted = memoize(() => rows.filter(Boolean), [rows]);
  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- fixture: the compiler caches the handler
  const onSelect = useCallback(() => consume(sorted), [sorted]);
  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- fixture: a namespace import is the same hook
  const count = ReactNamespace.useMemo(() => sorted.length, [sorted]);
  return <button type="button" onClick={onSelect}>{count}</button>;
};

export const OptedOut = () => {
  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- fixture: an opt-out hides a bailout from the guard
  "use no memo";
  return null;
};

export const Plain = ({ rows }: { rows: string[] }) => {
  // expect-clean: no-manual-memo/no-manual-memo
  const sorted = rows.filter(Boolean);
  // expect-clean: no-manual-memo/no-manual-memo
  const onSelect = () => consume(sorted);
  return <button type="button" onClick={onSelect}>{sorted.length}</button>;
};

declare const consume: (value: unknown) => void;
