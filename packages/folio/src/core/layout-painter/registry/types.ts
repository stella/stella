/**
 * Feature-module registry types for the layout painter.
 *
 * A feature module describes how to render one OOXML fragment kind. The
 * registry dispatches a Fragment to the module registered for its `kind`.
 * Each module exports a pure renderer; modules never import the registry.
 *
 * Mirrors folio's existing ProseMirror extension idiom
 * (`createNodeExtension({ name, nodeSpec, ... })`) so contributors find the
 * pattern familiar.
 */

import type {
  Fragment,
  FlowBlock,
  Measure,
  ParagraphBlock,
  ParagraphMeasure,
  TableBlock,
  TableMeasure,
  ImageBlock,
  ImageMeasure,
  TextBoxBlock,
  TextBoxMeasure,
} from "../../layout-engine/types";
import type { RenderContext } from "../renderUtils";

/**
 * Resolve the concrete Fragment subtype for a given kind discriminator.
 */
export type FragmentFor<TKind extends Fragment["kind"]> = Extract<
  Fragment,
  { kind: TKind }
>;

/**
 * Maps Fragment kind -> concrete Block subtype. The block lookup table
 * passes a `FlowBlock`; modules use this to narrow to the block they need
 * without unsafe casts.
 */
export type BlockFor<TKind extends Fragment["kind"]> = TKind extends "paragraph"
  ? ParagraphBlock
  : TKind extends "table"
    ? TableBlock
    : TKind extends "image"
      ? ImageBlock
      : TKind extends "textBox"
        ? TextBoxBlock
        : FlowBlock;

/**
 * Maps Fragment kind -> concrete Measure subtype. Same intent as `BlockFor`.
 */
export type MeasureFor<TKind extends Fragment["kind"]> =
  TKind extends "paragraph"
    ? ParagraphMeasure
    : TKind extends "table"
      ? TableMeasure
      : TKind extends "image"
        ? ImageMeasure
        : TKind extends "textBox"
          ? TextBoxMeasure
          : Measure;

/**
 * Inputs handed to a feature module's render function.
 */
export type FeatureRenderInput<TKind extends Fragment["kind"]> = {
  fragment: FragmentFor<TKind>;
  block: BlockFor<TKind>;
  measure: MeasureFor<TKind>;
  context: RenderContext;
  doc: Document;
};

/**
 * One renderer for one OOXML fragment kind. Pure — no instance state.
 */
export type FeatureModule<TKind extends Fragment["kind"] = Fragment["kind"]> = {
  readonly kind: TKind;
  render(input: FeatureRenderInput<TKind>): HTMLElement;
};

/**
 * Dispatch input: caller hands the registry the still-untyped fragment plus
 * its associated block/measure, and the registry narrows by kind.
 */
export type FeatureDispatchInput = {
  fragment: Fragment;
  block: FlowBlock | undefined;
  measure: Measure | undefined;
  context: RenderContext;
  doc: Document;
};

/**
 * Fallback hook invoked when no module matches the fragment's kind (or when
 * block/measure are missing for a fragment that needs them). Mirrors the
 * existing `renderFragment` placeholder behaviour so partial registries stay
 * safe at runtime.
 */
export type FeatureFallback = (input: {
  fragment: Fragment;
  context: RenderContext;
  doc: Document;
}) => HTMLElement;
