import type { ReactNode } from "react";
import { useState } from "react";

import {
  ArrowLeftIcon,
  CircleHelpIcon,
  CopyIcon,
  ListFilterIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import type { ConditionNode, GroupNode, Operand } from "@stll/conditions";
import { conditionHasFormula, conditionNodeSchema } from "@stll/conditions";
import type { DirectiveRange } from "@stll/folio-react";
import { isFieldPath, serializeCondition } from "@stll/template-conditions";
import { Button } from "@stll/ui/components/button";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { TextSeparator } from "@stll/ui/components/separator";
import { stellaToast } from "@stll/ui/components/toast";

import { AIPromptInput } from "@/components/ai-prompt-input/ai-prompt-input";
import {
  ConditionGroupEditor,
  emptyGroup,
  toRuleFields,
} from "@/routes/_protected.knowledge/-components/condition-builder";
import { createTemplateFieldMention } from "@/routes/_protected.knowledge/-components/template-field-mention";
import {
  nextFreePath,
  sanitizeFieldPath,
} from "@/routes/_protected.knowledge/-components/template-studio-model";
import type { OperatorWordKey } from "@/routes/_protected.knowledge/-components/template-studio-outline";
import { humanizeConditionExpr } from "@/routes/_protected.knowledge/-components/template-studio-outline";
import type { StudioField } from "@/routes/_protected.knowledge/-components/template-studio-store";
import { useTemplateStudioStore } from "@/routes/_protected.knowledge/-components/template-studio-store";
import type { FieldValidation } from "@/routes/_protected.knowledge/-components/template-wizard";

const ScopeHeader = ({
  title,
  subtitle,
  action,
  onBack,
}: {
  title?: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  onBack?: () => void;
}) => {
  const t = useTranslations();
  return (
    <div className="flex min-h-12 items-center justify-between gap-2 border-b px-3 py-2">
      {onBack === undefined ? null : (
        <Button
          aria-label={t("common.goBack")}
          className="-ms-1.5 shrink-0 self-start"
          onClick={onBack}
          size="icon-sm"
          variant="ghost"
        >
          <DirectionalIcon icon={ArrowLeftIcon} />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        {title === undefined ? null : (
          <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            {title}
          </p>
        )}
        {subtitle === undefined ? null : (
          <div className="min-w-0 overflow-hidden text-sm">{subtitle}</div>
        )}
      </div>
      {action === undefined ? null : (
        <div className="shrink-0 self-start">{action}</div>
      )}
    </div>
  );
};

export const booleanFieldForExpr = (
  expr: string,
  fields: readonly StudioField[],
): StudioField | undefined => {
  const trimmed = expr.trim();
  if (trimmed === "" || !isFieldPath(trimmed)) {
    return undefined;
  }
  const field = fields.find((f) => f.path === trimmed);
  return field?.inputType === "boolean" ? field : undefined;
};

// ── Conditions = boolean fields ──────────────────────────

/** How a boolean field's yes/no value arises. The three are mutually
 *  exclusive (backend-validated):
 *   - asked: a plain boolean, answered Yes/No in the fill form (a question).
 *   - rule:  DERIVED from `condition` (a `@stll/template-conditions` rule).
 *   - ai:    decided by the model from `aiPrompt`.
 *  A boolean field is always a reusable condition; this discriminates only
 *  *how* it resolves. */
type ConditionSource =
  | { kind: "asked" }
  | { kind: "rule"; expr: string; node?: ConditionNode }
  | { kind: "ai"; prompt: string };

const conditionSourceOf = (field: StudioField): ConditionSource => {
  // An AST is authoritative when set (formula rules have no `{{#if}}` string
  // form, so they only ever round-trip as the AST).
  if (field.conditionAst !== undefined) {
    return { kind: "rule", expr: "", node: field.conditionAst };
  }
  if (field.condition !== undefined && field.condition.trim() !== "") {
    return { kind: "rule", expr: field.condition };
  }
  if (field.aiPrompt !== undefined && field.aiPrompt.trim() !== "") {
    return { kind: "ai", prompt: field.aiPrompt };
  }
  return { kind: "asked" };
};

const isBooleanField = (field: StudioField): boolean =>
  field.inputType === "boolean";

/** Seed a rule editor's working group from a derived source: an AST-backed rule
 *  reopens with its own node (wrapped into a group when it is a leaf); anything
 *  else starts from an empty single-row group. */
const initialRuleGroup = (source: ConditionSource): GroupNode => {
  if (source.kind === "rule" && source.node !== undefined) {
    return source.node.type === "group"
      ? source.node
      : { type: "group", combinator: "and", children: [source.node] };
  }
  return emptyGroup();
};

const conditionHasLeaf = (node: ConditionNode): boolean => {
  if (node.type === "group") {
    return node.children.some(conditionHasLeaf);
  }
  return true;
};

const isBlankFormulaOperand = (operand: Operand): boolean =>
  operand.type === "formula" && operand.expr.trim() === "";

const isBlankLiteralOperand = (operand: Operand): boolean =>
  operand.type === "literal" &&
  typeof operand.value === "string" &&
  operand.value.trim() === "";

const hasBlankFormulaComparisonValue = (node: ConditionNode): boolean => {
  if (node.type === "group") {
    return node.children.some(hasBlankFormulaComparisonValue);
  }
  if (node.type === "predicate") {
    return isBlankFormulaOperand(node.operand);
  }
  if (isBlankFormulaOperand(node.left) || isBlankFormulaOperand(node.right)) {
    return true;
  }
  const comparesFormula =
    node.left.type === "formula" || node.right.type === "formula";
  return (
    comparesFormula &&
    (isBlankLiteralOperand(node.left) || isBlankLiteralOperand(node.right))
  );
};

const isPersistableFormulaGroup = (group: GroupNode): boolean =>
  v.is(conditionNodeSchema, group) && !hasBlankFormulaComparisonValue(group);

/** Persist a built rule onto a condition-field, picking the storage form by
 *  whether it contains a formula operand: a formula has no `{{#if}}` string
 *  form, so it must persist as the AST; otherwise serialize to the string and
 *  clear any stale AST. The two forms are mutually exclusive. */
const persistRuleGroup = (
  path: string,
  group: GroupNode,
  upsertField: (path: string, patch: Partial<StudioField>) => void,
): void => {
  if (conditionHasFormula(group)) {
    if (!isPersistableFormulaGroup(group)) {
      return;
    }
    upsertField(path, {
      condition: undefined,
      conditionAst: group,
      aiPrompt: undefined,
    });
    return;
  }
  const expression = serializeCondition(group);
  upsertField(path, {
    condition: expression === "" ? undefined : expression,
    conditionAst: undefined,
    aiPrompt: undefined,
  });
};

const canPersistRuleGroup = (group: GroupNode): boolean =>
  conditionHasLeaf(group) &&
  (!conditionHasFormula(group) || isPersistableFormulaGroup(group));

/** One reusable condition the picker can insert: every boolean field (its bare
 *  path is the gate). Shown in plain language; inserting references it by path
 *  so editing the source once updates every `{{#if}}` that points at it. */
type ReusableCondition = {
  /** The token a marker references: the field path. */
  ref: string;
  /** Plain-language reading for the list. */
  label: string;
  source: "asked" | "rule" | "ai";
};

/** Plain-language label for a condition-field: its own label, else the
 *  humanized rule, else the field path. */
const conditionFieldLabel = (
  field: StudioField,
  fields: readonly StudioField[],
  operatorWord: (key: OperatorWordKey) => string,
): string => {
  if (field.label.trim() !== "") {
    return field.label;
  }
  const source = conditionSourceOf(field);
  if (source.kind === "rule") {
    return humanizeConditionExpr(source.expr, fields, operatorWord);
  }
  return field.path;
};

/** Enumerate reusable conditions from the session: every boolean field is a
 *  condition addressed by its own path. */
export const reusableConditions = (
  fields: readonly StudioField[],
  operatorWord: (key: OperatorWordKey) => string,
): ReusableCondition[] => {
  const out: ReusableCondition[] = [];
  for (const field of fields) {
    if (!isBooleanField(field)) {
      continue;
    }
    const source = conditionSourceOf(field);
    out.push({
      ref: field.path,
      label: conditionFieldLabel(field, fields, operatorWord),
      source: source.kind,
    });
  }
  return out;
};

/** Auto-derive a human label for a freshly built condition-field from its
 *  expression ("Client type is company"), so the reuse picker reads in plain
 *  language without the author naming it. */
const labelForConditionExpr = (
  expr: string,
  fields: readonly StudioField[],
  operatorWord: (key: OperatorWordKey) => string,
): string => {
  const friendly = humanizeConditionExpr(expr, fields, operatorWord);
  return friendly.charAt(0).toUpperCase() + friendly.slice(1);
};

/** Freeze a stable, collision-safe slug `path` for a new condition-field from
 *  its derived label (or expression). Mirrors the question path freezing. */
const freezeConditionPath = (
  seed: string,
  fields: readonly StudioField[],
): string => {
  const base = sanitizeFieldPath(seed) || "condition";
  return nextFreePath(base, (candidate) =>
    fields.some((f) => f.path === candidate),
  );
};

/**
 * Settings face for a `{{#if}}` / `{{#elseif}}` opener. Teaches the two real
 * ways a condition is expressed, cheapest first:
 *   1. Ask a yes/no question — creates a boolean field and points the block at
 *      its bare name, so the filler sees a Yes/No toggle (zero syntax).
 *   2. Only when a field matches — a visual `field operator value` rule builder.
 *   3. Advanced (collapsed) — the raw expression editor.
 */
export const ConditionFace = ({
  selected,
  fields,
}: {
  selected: DirectiveRange;
  fields: StudioField[];
}) => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const rewrite = (next: string) =>
    actions?.rewriteConditionExpr(next) ?? false;
  // A block that already references a boolean condition-field edits the FIELD's
  // source (asked / rule / AI), so the single field is the source of truth and
  // every `{{#if path}}` pointing at it follows. Otherwise (a raw expression)
  // fall back to the builder, which also lets the author repoint the block at a
  // reusable condition.
  const conditionField = booleanFieldForExpr(selected.expr, fields);
  const humanEcho = conditionField?.label;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ScopeHeader
        action={
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  aria-label={t("templates.studio.conditionHelpTooltip")}
                  size="icon-sm"
                  variant="ghost"
                >
                  <CircleHelpIcon />
                </Button>
              }
            />
            <PopoverPopup className="max-w-xs p-3">
              <p className="text-xs">
                {t("templates.studio.conditionHelpTooltip")}
              </p>
            </PopoverPopup>
          </Popover>
        }
        onBack={() => actions?.deselect()}
        subtitle={
          humanEcho !== undefined && humanEcho !== ""
            ? humanEcho
            : humanizeConditionExpr(selected.expr, fields, (key) => t(key))
        }
      />
      <div className="flex flex-col gap-5 px-4 py-4">
        {conditionField === undefined ? (
          <ConditionBuilder
            expr={selected.expr}
            fields={fields}
            fromKey={`${selected.from}:${selected.expr}`}
            onRewrite={rewrite}
          />
        ) : (
          <ConditionFieldEditor field={conditionField} fields={fields} />
        )}
      </div>
    </ScrollArea>
  );
};

/**
 * Settings face for a `{{#each <path>}}` loop opener. Loops have no value of
 * their own; the only thing to configure is how many times they may repeat.
 * The bounds live on the loop-container FieldMeta whose path equals the array
 * path (`selected.expr`), which {@link LoopBoundsInputs} upserts.
 */
export const LoopFace = ({ selected }: { selected: DirectiveRange }) => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const arrayPath = selected.expr.trim();
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ScopeHeader
        onBack={() => actions?.deselect()}
        subtitle={<code className="text-xs">{arrayPath}</code>}
        title={t("templates.studio.scopeLoop")}
      />
      <div className="flex flex-col gap-4 px-4 py-4">
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("templates.studio.loopBoundsHint")}
        </p>
        <LoopBoundsInputs containerPath={arrayPath} />
      </div>
    </ScrollArea>
  );
};

/**
 * The two repeat-bound inputs (minimum / maximum repeats) for an `{{#each}}`
 * loop. Reads the bounds from the loop-container FieldMeta (path =
 * {@link containerPath}) and writes them back via `upsertField`, creating the
 * container record when absent. Shared by {@link LoopFace} and the
 * repeatable-field section of {@link FieldFace} so a single-field loop's author
 * sets bounds without hunting for the `{{#each}}` marker. An empty input unsets
 * the bound; min is clamped to ≤ max (and max to ≥ min) so an impossible range
 * cannot be saved.
 */
export const LoopBoundsInputs = ({
  containerPath,
}: {
  containerPath: string;
}) => {
  const t = useTranslations();
  const upsertField = useTemplateStudioStore((s) => s.upsertField);
  const validation = useTemplateStudioStore(
    (s) => s.fields.find((f) => f.path === containerPath)?.validation,
  );
  const minItems = validation?.minItems;
  const maxItems = validation?.maxItems;

  const writeBounds = (next: FieldValidation) => {
    const bounds: FieldValidation = {};
    if (next.minItems !== undefined) {
      bounds.minItems = next.minItems;
    }
    if (next.maxItems !== undefined) {
      bounds.maxItems = next.maxItems;
    }
    upsertField(containerPath, {
      validation: Object.keys(bounds).length > 0 ? bounds : undefined,
    });
  };

  const onMin = (raw: string) => {
    const value = parseBoundInput(raw);
    if (value === undefined) {
      writeBounds({ maxItems });
      return;
    }
    // Max stays at least one above min, so the range is never empty or fixed.
    const max =
      maxItems !== undefined && maxItems <= value ? value + 1 : maxItems;
    writeBounds({ minItems: value, maxItems: max });
  };

  const onMax = (raw: string) => {
    const value = parseBoundInput(raw);
    if (value === undefined) {
      writeBounds({ minItems });
      return;
    }
    // Max stays at least one above min; min is at least zero (a blank min field
    // is an implicit zero), so the smallest valid max is one. Clamp here, since
    // the `min` input attribute does not stop a typed/pasted 0.
    const max = Math.max(1, value);
    // Min stays at least one below max.
    const min = minItems !== undefined && minItems >= max ? max - 1 : minItems;
    writeBounds({ minItems: min, maxItems: max });
  };

  return (
    <div className="flex items-end gap-3">
      <div className="flex flex-1 flex-col gap-1.5">
        <Label className="text-sm" htmlFor="loop-min-repeats">
          {t("templates.studio.minRepeats")}
        </Label>
        <Input
          className="h-8"
          id="loop-min-repeats"
          inputMode="numeric"
          min={0}
          onChange={(e) => onMin(e.target.value)}
          placeholder="0"
          type="number"
          value={minItems === undefined ? "" : String(minItems)}
        />
      </div>
      <div className="flex flex-1 flex-col gap-1.5">
        <Label className="text-sm" htmlFor="loop-max-repeats">
          {t("templates.studio.maxRepeats")}
        </Label>
        <Input
          className="h-8"
          id="loop-max-repeats"
          inputMode="numeric"
          min={(minItems ?? 0) + 1}
          onChange={(e) => onMax(e.target.value)}
          placeholder={t("templates.studio.repeatsUnlimited")}
          type="number"
          value={maxItems === undefined ? "" : String(maxItems)}
        />
      </div>
    </div>
  );
};

/** Parse a repeat-bound input: a non-negative integer, or undefined when the
 *  input is empty/invalid (which unsets the bound). */
const parseBoundInput = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
};

/** Edit a boolean condition-field's SOURCE — how its yes/no value arises —
 *  writing back to the single field so every `{{#if path}}` that references it
 *  updates at once. The three sources are mutually exclusive:
 *   - asked: plain boolean, answered in the fill form (clears condition + AI).
 *   - rule:  a `condition` expression, DERIVED at fill time.
 *   - ai:    an `aiPrompt`, decided by the model.
 *  The label is editable inline; the path is frozen at creation. */
const ConditionFieldEditor = ({
  field,
  fields,
}: {
  field: StudioField;
  fields: StudioField[];
}) => {
  const t = useTranslations();
  const upsertField = useTemplateStudioStore((s) => s.upsertField);
  const derived = conditionSourceOf(field);
  // Seed from an existing AST rule so re-opening a formula (or any AST-backed)
  // rule shows its rows; otherwise start empty.
  const [group, setGroup] = useState<GroupNode>(() =>
    initialRuleGroup(derived),
  );
  // Clicking "Rule" with no expression yet keeps the derived source at "asked"
  // (no `condition` is written until Done), so track the picked tab locally to
  // reveal the right editor immediately.
  const [pick, setPick] = useState<ConditionSource["kind"] | null>(null);
  const sourceKind = pick ?? derived.kind;
  const ruleFields = toRuleFields(fields);

  const fieldMention = createTemplateFieldMention(
    fields
      .filter((f) => f.path !== field.path)
      .map((f) => ({ id: f.path, label: f.label || f.path })),
  );

  const setAsked = () => {
    setPick("asked");
    upsertField(field.path, {
      condition: undefined,
      conditionAst: undefined,
      aiPrompt: undefined,
    });
  };
  const setAi = () => {
    setPick("ai");
    upsertField(field.path, {
      condition: undefined,
      conditionAst: undefined,
      aiPrompt: field.aiPrompt ?? "",
    });
  };
  const applyRule = () => {
    if (!canPersistRuleGroup(group)) {
      return;
    }
    persistRuleGroup(field.path, group, upsertField);
    if (conditionHasFormula(group)) {
      return;
    }
    setGroup(emptyGroup());
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm">{t("common.name")}</Label>
        <Input
          className="h-9 text-sm"
          defaultValue={field.label}
          key={field.path}
          onBlur={(e) => {
            const next = e.currentTarget.value.trim();
            if (next !== field.label) {
              upsertField(field.path, { label: next });
            }
          }}
          placeholder={t("templates.studio.conditionLabelPlaceholder")}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label className="text-sm">
          {t("templates.studio.conditionSource")}
        </Label>
        <div className="flex items-center gap-1">
          <Button
            className="flex-1"
            onClick={setAsked}
            size="sm"
            variant={sourceKind === "asked" ? "secondary" : "ghost"}
          >
            <MessageCircleQuestionIcon className="size-3.5" />
            {t("templates.studio.conditionSourceAsked")}
          </Button>
          <Button
            className="flex-1"
            onClick={() => {
              setPick("rule");
              upsertField(field.path, { aiPrompt: undefined });
            }}
            size="sm"
            variant={sourceKind === "rule" ? "secondary" : "ghost"}
          >
            <ListFilterIcon className="size-3.5" />
            {t("templates.studio.conditionSourceRule")}
          </Button>
          <Button
            className="flex-1"
            onClick={setAi}
            size="sm"
            variant={sourceKind === "ai" ? "secondary" : "ghost"}
          >
            <WandSparklesIcon className="size-3.5" />
            {t("templates.studio.conditionSourceAi")}
          </Button>
        </div>
      </div>
      {sourceKind === "asked" ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("templates.studio.conditionAskQuestionHelp")}
        </p>
      ) : null}
      {sourceKind === "rule" ? (
        <div className="flex flex-col gap-2">
          {derived.kind === "rule" && derived.expr.trim() !== "" ? (
            <p className="text-foreground text-sm">
              {humanizeConditionExpr(derived.expr, fields, (key) => t(key))}
            </p>
          ) : null}
          <ConditionGroupEditor
            fields={ruleFields}
            group={group}
            onChange={setGroup}
          />
          <Button
            className="self-start"
            disabled={!canPersistRuleGroup(group)}
            onClick={applyRule}
            size="sm"
          >
            {t("common.done")}
          </Button>
        </div>
      ) : null}
      {sourceKind === "ai" ? (
        <div className="flex flex-col gap-1.5">
          <Label className="text-sm">
            {t("templates.studio.conditionAiInstructionsLabel")}
          </Label>
          <div className="border-input bg-background focus-within:border-ring focus-within:ring-ring/24 rounded-lg border px-2.5 py-2 transition-shadow focus-within:ring-[3px]">
            <AIPromptInput
              mentionExtension={fieldMention}
              onChange={(value) =>
                upsertField(field.path, {
                  aiPrompt: value,
                  condition: undefined,
                })
              }
              placeholder={t("templates.studio.conditionAiPlaceholder")}
              value={field.aiPrompt ?? ""}
              valueFormat="text"
              variant="minimal"
            />
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("templates.studio.conditionAiInstructionsHelp")}
          </p>
        </div>
      ) : null}
    </div>
  );
};

/** The three-tier condition-setting UI (ask-a-question, match-a-field rule,
 *  advanced raw editor), shared by the ConditionFace (editing a selected
 *  `{{#if}}` opener) and the FieldFace's "Show only if…" section (editing the
 *  block that wraps the field's own marker). `onRewrite` is the only thing
 *  that differs between callers: it points at whichever block this builder
 *  targets. `fromKey` resets the question/advanced inputs when the target or
 *  its expression changes. */
export const ConditionBuilder = ({
  expr,
  fields,
  fromKey,
  onRewrite,
}: {
  expr: string;
  fields: StudioField[];
  fromKey: string;
  onRewrite: (next: string) => boolean;
}) => {
  const t = useTranslations();
  // One choice, not a stack of forms: pick how this block's visibility is
  // decided and show only that mode (mirrors the per-field condition picker).
  const [mode, setMode] = useState<"ask" | "rule">("ask");
  // Two ways to set this block's visibility: reuse an existing condition, or
  // build a fresh one. Reuse leads (option A) only when something exists to
  // reuse; an "or" divider then frames the builder below as the alternative,
  // mirroring the sign-in panel's "social / or / email" split.
  const hasReuse = reusableConditions(fields, (key) => t(key)).some(
    (c) => c.ref !== expr.trim(),
  );
  return (
    <div className="flex flex-col gap-4">
      {hasReuse ? (
        <>
          <ConditionReusePicker
            currentRef={expr}
            fields={fields}
            onRewrite={onRewrite}
          />
          <TextSeparator>
            {t("templates.studio.conditionOrBuildNew")}
          </TextSeparator>
        </>
      ) : null}
      <div className="flex items-center gap-1">
        <Button
          className="flex-1"
          onClick={() => setMode("ask")}
          size="sm"
          variant={mode === "ask" ? "secondary" : "ghost"}
        >
          <MessageCircleQuestionIcon className="size-3.5" />
          {t("templates.studio.conditionSourceAsked")}
        </Button>
        <Button
          className="flex-1"
          onClick={() => setMode("rule")}
          size="sm"
          variant={mode === "rule" ? "secondary" : "ghost"}
        >
          <ListFilterIcon className="size-3.5" />
          {t("templates.studio.conditionSourceRule")}
        </Button>
      </div>
      {mode === "ask" ? (
        <ConditionQuestionBuilder
          expr={expr}
          fields={fields}
          key={fromKey}
          onRewrite={onRewrite}
        />
      ) : (
        <ConditionRuleBuilder fields={fields} onRewrite={onRewrite} />
      )}
    </div>
  );
};

/** "Reuse a condition" affordance: every existing reusable condition (boolean
 *  fields), in plain language. Picking one points this block at it by reference
 *  (`{{#if <ref>}}`), so editing that condition's source once updates every
 *  block that reuses it. Quiet by convention: a single collapsed row, and
 *  nothing at all when there is nothing to reuse. */
const ConditionReusePicker = ({
  fields,
  currentRef,
  onRewrite,
}: {
  fields: StudioField[];
  /** The block's current expression; the matching reusable entry is hidden so
   *  the list only offers *other* conditions. */
  currentRef: string;
  onRewrite: (next: string) => boolean;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const current = currentRef.trim();
  const options = reusableConditions(fields, (key) => t(key)).filter(
    (c) => c.ref !== current,
  );

  if (options.length === 0) {
    return null;
  }

  if (!open) {
    return (
      <section className="flex flex-col gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          <CopyIcon className="text-muted-foreground size-4 shrink-0" />
          {t("templates.studio.conditionReuse")}
        </h4>
        <Button
          className="self-start"
          onClick={() => setOpen(true)}
          size="sm"
          variant="outline"
        >
          {t("templates.studio.conditionReusePick")}
        </Button>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2">
      <h4 className="flex items-center gap-1.5 text-sm font-medium">
        <CopyIcon className="text-muted-foreground size-4 shrink-0" />
        {t("templates.studio.conditionReuse")}
      </h4>
      <ul className="flex flex-col">
        {options.map((option) => (
          <li key={option.ref}>
            <button
              className="hover:bg-muted flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-start text-sm"
              onClick={() => {
                if (!onRewrite(option.ref)) {
                  stellaToast.add({
                    type: "error",
                    title: t("templates.studio.invalidExpression"),
                  });
                  return;
                }
                setOpen(false);
              }}
              title={option.ref}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <code className="text-muted-foreground shrink-0 text-[10px]">
                {option.ref}
              </code>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** Primary, no-syntax path: a question label becomes a boolean field whose
 *  bare name is the block's condition. The filler answers Yes/No; the block
 *  shows on Yes. Prefilled with the current boolean field's label when the
 *  condition already points at one. */
const ConditionQuestionBuilder = ({
  expr,
  fields,
  onRewrite,
}: {
  expr: string;
  fields: StudioField[];
  onRewrite: (next: string) => boolean;
}) => {
  const t = useTranslations();
  const upsertField = useTemplateStudioStore((s) => s.upsertField);
  const existing = booleanFieldForExpr(expr, fields);
  const [label, setLabel] = useState(existing?.label ?? "");

  const commit = () => {
    const trimmed = label.trim();
    if (trimmed === "") {
      return;
    }
    // Editing an existing question: keep its field/path, just relabel.
    if (existing !== undefined) {
      if (trimmed !== existing.label) {
        upsertField(existing.path, { label: trimmed });
      }
      return;
    }
    const base = sanitizeFieldPath(trimmed) || "question";
    const taken = (candidate: string) =>
      useTemplateStudioStore
        .getState()
        .fields.some((f) => f.path === candidate);
    const path = nextFreePath(base, taken);
    upsertField(path, { inputType: "boolean", label: trimmed });
    onRewrite(path);
  };

  return (
    <section className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs leading-relaxed">
        {t("templates.studio.conditionAskQuestionHelp")}
      </p>
      <Input
        className="h-9 text-sm"
        onBlur={commit}
        onChange={(e) => setLabel(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
            return;
          }
          if (e.key === "Escape") {
            setLabel(existing?.label ?? "");
            e.currentTarget.blur();
          }
        }}
        placeholder={t("templates.studio.conditionAskQuestionPlaceholder")}
        value={label}
      />
    </section>
  );
};

/** Secondary path: a visual `field operator value` rule (All/Any of several),
 *  populated from the template's non-boolean fields. Serialization is one-way
 *  (building sets the raw expression); the builder does not parse an existing
 *  expression back, so it always starts empty — the current expression still
 *  shows in Advanced below. */
const ConditionRuleBuilder = ({
  fields,
  onRewrite,
}: {
  fields: StudioField[];
  onRewrite: (next: string) => boolean;
}) => {
  const t = useTranslations();
  const upsertField = useTemplateStudioStore((s) => s.upsertField);
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<GroupNode>(emptyGroup);
  const ruleFields = toRuleFields(fields);

  // Building a rule does not point the block at a raw expression; it creates a
  // reusable boolean condition-field whose value is DERIVED by that rule, then
  // points the block at the field's path. The field is then in the reuse
  // picker and edit-once-propagates to every `{{#if path}}` referencing it.
  const apply = () => {
    const isFormula = conditionHasFormula(group);
    if (isFormula && !canPersistRuleGroup(group)) {
      return;
    }
    // A formula rule has no `{{#if}}` string form, so it can only be derived a
    // label from the field name (not the humanized expression) and is persisted
    // as the AST. Otherwise serialize as before.
    const expression = isFormula ? "" : serializeCondition(group);
    if (!isFormula && expression === "") {
      return;
    }
    const label = isFormula
      ? t("templates.studio.conditionRuleFallbackLabel")
      : labelForConditionExpr(expression, fields, (key) => t(key));
    const path = freezeConditionPath(label, fields);
    upsertField(path, {
      inputType: "boolean",
      label,
      condition: isFormula ? undefined : expression,
      conditionAst: isFormula ? group : undefined,
    });
    if (onRewrite(path)) {
      setGroup(emptyGroup());
      setOpen(false);
      return;
    }
    stellaToast.add({
      type: "error",
      title: t("templates.studio.invalidExpression"),
    });
  };

  if (!open) {
    return (
      <section className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("templates.studio.conditionMatchFieldHelp")}
        </p>
        <Button
          className="self-start"
          onClick={() => setOpen(true)}
          size="sm"
          variant="outline"
        >
          <PlusIcon />
          {t("templates.studio.conditionBuildRule")}
        </Button>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2">
      <ConditionGroupEditor
        fields={ruleFields}
        group={group}
        onChange={setGroup}
      />
      <div className="flex items-center gap-2">
        <Button
          disabled={!canPersistRuleGroup(group)}
          onClick={apply}
          size="sm"
        >
          {t("common.done")}
        </Button>
        <Button
          onClick={() => {
            setGroup(emptyGroup());
            setOpen(false);
          }}
          size="sm"
          variant="ghost"
        >
          {t("common.cancel")}
        </Button>
      </div>
    </section>
  );
};
