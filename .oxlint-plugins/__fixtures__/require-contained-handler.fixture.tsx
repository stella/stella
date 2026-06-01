// Passive regression fixture for
// `require-contained-handler/require-contained-handler`.
//
// `oxlint-disable-next-line` below intentionally suppresses cases the
// rule MUST flag. If the rule regresses, the corresponding disable
// becomes unused and `--report-unused-disable-directives-severity=error`
// fails CI. Lines without a disable directive must continue to pass.

import type { RefObject, SyntheticEvent } from "react";

import { containedHandler } from "@stll/ui/hooks/use-contained-handler";

const noop = (_event?: SyntheticEvent) => void 0;

const buttonRef: RefObject<HTMLButtonElement | null> = { current: null };
const inputRef: RefObject<HTMLInputElement | null> = { current: null };
const refs = { container: buttonRef };

// --- Cases the rule MUST flag ---

export const FlagBareHandler = () => (
  <button
    type="button"
    ref={buttonRef}
    // oxlint-disable-next-line require-contained-handler/require-contained-handler
    onMouseDown={noop}
  />
);

export const FlagInlineArrow = () => (
  <button
    type="button"
    ref={buttonRef}
    // oxlint-disable-next-line require-contained-handler/require-contained-handler
    onClick={(e) => e.preventDefault()}
  />
);

export const FlagMemberRef = () => (
  <button
    type="button"
    ref={refs.container}
    // oxlint-disable-next-line require-contained-handler/require-contained-handler
    onPointerDown={noop}
  />
);

export const FlagCallbackRef = () => (
  <button
    type="button"
    ref={(el) => {
      buttonRef.current = el;
    }}
    // oxlint-disable-next-line require-contained-handler/require-contained-handler
    onClick={noop}
  />
);

export const FlagWrongCall = () => (
  <button
    type="button"
    ref={buttonRef}
    // oxlint-disable-next-line require-contained-handler/require-contained-handler
    onFocus={() => noop()}
  />
);

// --- Cases the rule MUST NOT flag ---

export const Wrapped = () => (
  <button
    type="button"
    ref={buttonRef}
    onMouseDown={containedHandler(buttonRef, noop)}
  />
);

export const ConditionalWrapped = ({ inline }: { inline: boolean }) => (
  <button
    type="button"
    ref={buttonRef}
    onMouseDown={inline ? undefined : containedHandler(buttonRef, noop)}
  />
);

export const UndefinedHandler = () => (
  <button type="button" ref={buttonRef} onMouseDown={undefined} />
);

export const NoRef = () => <button type="button" onMouseDown={noop} />;

export const NoWatchedHandler = () => (
  <button type="button" ref={buttonRef} onChange={noop} />
);

// `onBlur` is intentionally outside WATCHED_HANDLERS — see the
// containedHandler helper docs for why blur is incompatible.
export const BareBlur = () => <input ref={inputRef} onBlur={noop} />;
