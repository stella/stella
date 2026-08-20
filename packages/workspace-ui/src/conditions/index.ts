/**
 * The nested condition builder over the `@stll/conditions` AST.
 *
 * One module rather than one subpath per file: the component only means
 * anything against the field descriptions and operator sets in `logic`, and
 * the logic is only ever read to feed the component.
 *
 * The module resolves no strings and reads no schema of its own. A host
 * describes its operands as `FieldOption`s — whose `valueType` picks both the
 * operator set and the value editor — and brings every label it draws.
 */

export type {
  ConditionBuilderLabels,
  ConditionCapabilities,
  FormulaCellRenderCtx,
  ValueEditorRenderCtx,
} from "./builder";
export { ConditionBuilder } from "./builder";
export type {
  ConditionOperator,
  FieldOption,
  FieldOptionChoice,
  FieldValueType,
  ValueEditorKind,
} from "./logic";
export {
  appendChild,
  asGroup,
  buildLeaf,
  CONDITION_OPERATORS,
  fieldForNode,
  isConditionOperator,
  isMultiValue,
  leafFromField,
  leafOperand,
  leafOperator,
  leafValueList,
  leafValueString,
  operandsEqual,
  operatorsFor,
  removeChild,
  replaceChild,
  valueEditorFor,
} from "./logic";
