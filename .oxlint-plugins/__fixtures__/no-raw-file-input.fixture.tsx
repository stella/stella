// Passive regression fixture for `no-raw-file-input/no-raw-file-input`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { useRef } from "react";

const inputType = "text";

// --- Flagged: a rendered file input, visible or hidden ---
export const _a = () => (
  // oxlint-disable-next-line no-raw-file-input/no-raw-file-input
  <input type="file" />
);
export const HiddenPicker = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button onClick={() => inputRef.current?.click()} type="button">
        Upload
      </button>
      {/* oxlint-disable-next-line no-raw-file-input/no-raw-file-input */}
      <input accept=".docx" className="hidden" ref={inputRef} type="file" />
    </>
  );
};
export const _c = () => (
  // oxlint-disable-next-line no-raw-file-input/no-raw-file-input
  <input type={"file"} />
);

// --- Allowed: any other input type, and a dynamic type ---
export const _ok1 = () => <input type="text" />;
export const _ok2 = () => <input type={inputType} />;
export const _ok3 = () => <input />;
