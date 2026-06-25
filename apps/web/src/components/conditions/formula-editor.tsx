import { useRef, useState } from "react";

import { FunctionSquareIcon, HashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { evaluateNumericExpression } from "@stll/template-conditions";
import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

/** A numeric operand the formula may reference. `path` is the exact name the
 *  expression and the evaluator use (already row-relative when inside a loop);
 *  `label` is the human caption for chips and the worked example. */
type FormulaNumberField = {
  path: string;
  label: string;
};

type FormulaEditorProps = {
  numberFields: readonly FormulaNumberField[];
  /** Every in-scope field a formula may name, including non-numeric ones. A
   *  reference to a known non-number field warns "not a number" (instead of
   *  "unknown") and still renders as a chip in the preview. Defaults to
   *  `numberFields` when the caller exposes only numeric operands (the rule
   *  builder), where the distinction does not arise. */
  knownFields?: readonly FormulaNumberField[];
  value: string;
  onChange: (formula: string) => void;
  /** Focus the expression input on mount (set when rendered inside a popover so
   *  the author can type immediately). */
  autoFocus?: boolean;
};

// Built-in formula functions are not field references; mirror the evaluator's
// identifier grammar (compute.ts) so the "not a field" check matches what the
// engine will actually resolve.
const FORMULA_FUNCTIONS = new Set([
  "min",
  "max",
  "round",
  "abs",
  "floor",
  "ceil",
]);
const FORMULA_IDENT_RE = /[\p{L}_][\p{L}\p{N}_.]*(?:-[\p{L}\p{N}_.]+)*/gu;

// Math tokens the toolbar can insert. The glyph is what the author sees; the
// token is the canonical operator the evaluator understands (so the stored
// formula stays in `* / -` form, never the human × ÷ − glyphs).
const FORMULA_OPERATOR_TOKENS: readonly { glyph: string; token: string }[] = [
  { glyph: "+", token: "+" },
  { glyph: "−", token: "-" },
  { glyph: "×", token: "*" },
  { glyph: "÷", token: "/" },
  { glyph: "%", token: "%" },
  { glyph: "(", token: "(" },
  { glyph: ")", token: ")" },
];
const FORMULA_FUNCTION_TOKENS: readonly string[] = [
  "min(",
  "max(",
  "round(",
  "abs(",
  "floor(",
  "ceil(",
];

/** Popover buttons act on the captured selection; preventing mousedown keeps
 *  focus (and the painted caret) in the input while clicking a chip/operator. */
const keepEditorFocus = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

/** Formula editor: the expression input, clickable chips of the number fields
 *  you can reference, a math-symbol toolbar, a live worked example with made-up
 *  values, a read-only chip preview of the expression, and warnings for names
 *  that are not fields or not numbers. The in-scope numeric operands are
 *  resolved by the caller and passed as `numberFields` (each `path` is the
 *  reference name the expression uses). */
export const FormulaEditor = ({
  numberFields,
  knownFields = numberFields,
  value,
  onChange,
  autoFocus = false,
}: FormulaEditorProps) => {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldsByRef = new Map(knownFields.map((f) => [f.path, f]));
  const knownRefs = new Set(fieldsByRef.keys());
  const numberRefs = new Set(numberFields.map((f) => f.path));
  // True when at least one in-scope field is non-numeric, so the editor can
  // remind the author that only numbers are usable in a formula.
  const hasNonNumberFields = knownRefs.size > numberRefs.size;
  const referenced = [
    ...new Set(
      [...value.matchAll(FORMULA_IDENT_RE)]
        .map((match) => match[0])
        .filter((id) => !FORMULA_FUNCTIONS.has(id)),
    ),
  ];
  const unknown = referenced.filter((name) => !knownRefs.has(name));
  // Known fields referenced but not numbers: the evaluator coerces them to NaN.
  const nonNumber = referenced.filter(
    (name) => knownRefs.has(name) && !numberRefs.has(name),
  );

  // The controlled re-render after onChange drops the caret to the end; restore
  // it past the inserted text on the next frame so chained inserts keep typing
  // where the user left off. Paired with onMouseDown preventDefault on the
  // buttons, which stops the click from stealing focus out of the input.
  const restoreCaret = (position: number) => {
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input === null) {
        return;
      }
      input.focus();
      input.setSelectionRange(position, position);
    });
  };

  const insertAtCaret = (token: string) => {
    const input = inputRef.current;
    // Append when the input is not focused/measurable; otherwise splice the
    // token at the current selection so the caret position is respected.
    if (input === null) {
      onChange(`${value}${token}`);
      return;
    }
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    onChange(`${value.slice(0, start)}${token}${value.slice(end)}`);
    restoreCaret(start + token.length);
  };

  const appendField = (path: string) => {
    const input = inputRef.current;
    if (input === null) {
      // No separator right after an opening operator/paren or on an empty
      // expression; otherwise a space so adjacent names do not merge.
      const needsSpace = value !== "" && !/[\s(+\-*/%,]$/u.test(value);
      onChange(`${value}${needsSpace ? " " : ""}${path}`);
      return;
    }
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const needsSpace = before !== "" && !/[\s(+\-*/%,]$/u.test(before);
    const inserted = `${needsSpace ? " " : ""}${path}`;
    onChange(`${before}${inserted}${value.slice(end)}`);
    restoreCaret(start + inserted.length);
  };

  // Accept human multiplication/division glyphs as shorthand. `×`/`÷` are
  // unambiguous (never part of an identifier), so map them directly. A bare
  // `x` only becomes `*` when it sits between operand-ish characters (space,
  // digit, closing paren on the left; space, digit, opening paren on the
  // right) — single-char bounds keep this linear (no backtracking) and never
  // rewrite the `x` inside an identifier like `taxRate` or `maxFee`.
  const handleInputChange = (raw: string) => {
    const canonical = raw
      .replace(/×/gu, "*")
      .replace(/÷/gu, "/")
      .replace(/(?<lead>[\s\d)])x(?=[\s\d(])/gu, "$<lead>*");
    onChange(canonical);
  };

  // Worked example: assign each referenced number field a distinct made-up
  // integer (100, 200, 300…) keyed by its reference name, then evaluate the
  // expression against that flat data object. The evaluator resolves exact keys.
  const exampleFields = referenced
    .filter((name) => numberRefs.has(name))
    .map((name, index) => ({ path: name, value: (index + 1) * 100 }));
  const exampleData: Record<string, number> = {};
  for (const entry of exampleFields) {
    exampleData[entry.path] = entry.value;
  }
  const exampleResult =
    value.trim() === ""
      ? undefined
      : evaluateNumericExpression(value, exampleData);
  const finiteExampleResult =
    exampleResult !== undefined && Number.isFinite(exampleResult)
      ? exampleResult
      : undefined;

  // Light tokenization for the read-only chip strip: identifier spans become
  // chips, everything between them renders as muted inline mono text.
  const previewTokens: { text: string; isField: boolean }[] = [];
  let cursor = 0;
  for (const match of value.matchAll(FORMULA_IDENT_RE)) {
    const id = match[0];
    const at = match.index;
    if (at > cursor) {
      previewTokens.push({ text: value.slice(cursor, at), isField: false });
    }
    previewTokens.push({ text: id, isField: knownRefs.has(id) });
    cursor = at + id.length;
  }
  if (cursor < value.length) {
    previewTokens.push({ text: value.slice(cursor), isField: false });
  }

  return (
    <>
      <Input
        autoFocus={autoFocus}
        className="h-8 font-mono text-xs"
        dir="ltr"
        onChange={(e) => handleInputChange(e.target.value)}
        placeholder={t("templates.fieldFormulaExpression")}
        ref={inputRef}
        value={value}
      />
      <div className="flex gap-1 overflow-x-auto pb-1">
        {FORMULA_OPERATOR_TOKENS.map((op) => (
          <Button
            className="shrink-0 font-mono"
            key={op.token}
            onClick={() => insertAtCaret(op.token)}
            onMouseDown={keepEditorFocus}
            size="xs"
            type="button"
            variant="outline"
          >
            {op.glyph}
          </Button>
        ))}
        <span className="w-1 shrink-0" />
        {FORMULA_FUNCTION_TOKENS.map((fn) => (
          <Button
            className="shrink-0 font-mono"
            key={fn}
            onClick={() => insertAtCaret(fn)}
            onMouseDown={keepEditorFocus}
            size="xs"
            type="button"
            variant="outline"
          >
            {fn}
          </Button>
        ))}
      </div>
      {numberFields.length > 0 && (
        <div className="flex gap-1 overflow-x-auto pb-1">
          {numberFields.map((f) => (
            <Button
              className="shrink-0 font-mono"
              key={f.path}
              onClick={() => appendField(f.path)}
              onMouseDown={keepEditorFocus}
              size="xs"
              title={f.label || f.path}
              type="button"
              variant="outline"
            >
              <HashIcon className="size-3 shrink-0" />
              {f.path}
            </Button>
          ))}
        </div>
      )}
      {previewTokens.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-0.5 font-mono text-xs"
          dir="ltr"
        >
          {previewTokens.map((tok, index) => (
            <FormulaPreviewToken
              isField={tok.isField}
              key={index}
              text={tok.text}
            />
          ))}
        </div>
      )}
      {finiteExampleResult !== undefined && (
        <p className="text-muted-foreground text-xs">
          {t("templates.studio.formulaExampleLabel")}:{" "}
          {exampleFields.map((entry, index) => {
            const label = fieldsByRef.get(entry.path)?.label || entry.path;
            return (
              <span key={entry.path}>
                {index > 0 && ", "}
                {label} = {String(entry.value)}
              </span>
            );
          })}
          {exampleFields.length > 0 && " → "}
          {/* Mirror the document exactly: the fill writes String(result), so
              the preview shows the same raw value (no locale rounding) — the
              author controls decimals with round(x, n). */}
          <span className="text-foreground font-medium">
            {String(finiteExampleResult)}
          </span>
        </p>
      )}
      {unknown.length > 0 && (
        <p className="text-warning-foreground text-xs">
          {t("templates.studio.formulaUnknownFields", {
            fields: unknown.join(", "),
          })}
        </p>
      )}
      {nonNumber.length > 0 && (
        <p className="text-warning-foreground text-xs">
          {t("templates.studio.formulaNonNumberFields", {
            fields: nonNumber.join(", "),
          })}
        </p>
      )}
      {hasNonNumberFields && (
        <p className="text-muted-foreground text-xs">
          {t("templates.studio.formulaNumbersOnlyHelp")}
        </p>
      )}
      <p className="text-muted-foreground text-xs leading-relaxed">
        {t("templates.fieldFormulaExpressionHint")}
      </p>
    </>
  );
};

type FormulaCellProps = Omit<
  FormulaEditorProps,
  "knownFields" | "autoFocus"
> & {
  /** Revert this row's operand back to a plain field picker. */
  onUseField: () => void;
};

/** Compact in-row formula operand: shows `ƒ <expression>` as a trigger; the
 *  full editor (input, math toolbar, field chips, worked example) opens in a
 *  popover, so a calculated row stays one line and a simple field row never
 *  meets this chrome. */
export const FormulaCell = ({
  numberFields,
  value,
  onChange,
  onUseField,
}: FormulaCellProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            className="h-9 min-w-32 flex-1 justify-start gap-1.5 px-3 font-normal"
            type="button"
            variant="outline"
          />
        }
      >
        <FunctionSquareIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span
          className={cn(
            "min-w-0 truncate font-mono",
            value === "" && "text-muted-foreground",
          )}
          dir="ltr"
        >
          {value === "" ? t("templates.conditionFormulaPlaceholder") : value}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80" side="bottom">
        <div className="flex flex-col gap-2 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">
              {t("templates.conditionFormulaTitle")}
            </span>
            <Button
              onClick={() => {
                onUseField();
                setOpen(false);
              }}
              size="xs"
              type="button"
              variant="ghost"
            >
              {t("templates.conditionUseFieldInstead")}
            </Button>
          </div>
          <FormulaEditor
            autoFocus
            numberFields={numberFields}
            onChange={onChange}
            value={value}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
};

/** One token in the read-only formula preview strip: a known field path becomes
 *  an accent chip; everything else (operators, numbers, function names) renders
 *  as muted inline mono text. */
const FormulaPreviewToken = ({
  isField,
  text,
}: {
  isField: boolean;
  text: string;
}) => {
  if (isField) {
    return (
      <span className="bg-accent text-accent-foreground rounded px-1 py-0.5 font-mono text-xs">
        {text}
      </span>
    );
  }
  return <span className="text-muted-foreground">{text}</span>;
};
