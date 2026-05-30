/**
 * Layout Painter
 *
 * Main entry point for rendering Layout data to DOM.
 * Provides reconciliation for efficient incremental updates.
 */

import { panic } from "better-result";

import { prefersReducedMotionBehavior } from "../../paged-editor/scrollNavigation";
import type {
  Layout,
  Page,
  Fragment,
  FlowBlock,
  Measure,
} from "../layout-engine/types";
import { createDefaultRegistry } from "./registry/modules";
import type { FeatureRegistry } from "./registry/registry";
import { renderFragment, FRAGMENT_CLASS_NAMES } from "./renderFragment";
import { renderImageFragment, IMAGE_CLASS_NAMES } from "./renderImage";
import { renderPage, renderPages } from "./renderPage";
import {
  renderParagraphFragment,
  sliceRunsForLine,
  renderLine,
} from "./renderParagraph";
import { renderTableFragment, TABLE_CLASS_NAMES } from "./renderTable";
import { renderTextBoxFragment, TEXTBOX_CLASS_NAMES } from "./renderTextBox";
import type { RenderContext } from "./renderUtils";

// Re-export render functions
export {
  renderPage,
  renderPages,
  renderParagraphFragment,
  renderTableFragment,
  renderImageFragment,
  renderFragment,
  sliceRunsForLine,
  renderLine,
  FRAGMENT_CLASS_NAMES,
  TABLE_CLASS_NAMES,
  IMAGE_CLASS_NAMES,
  renderTextBoxFragment,
  TEXTBOX_CLASS_NAMES,
  type RenderContext,
};

// Re-export feature-module registry surface
export { createFeatureRegistry } from "./registry/registry";
export type { FeatureRegistry } from "./registry/registry";
export { createDefaultRegistry } from "./registry/modules";
export type {
  FeatureModule,
  FeatureRenderInput,
  FeatureDispatchInput,
  FeatureFallback,
  BlockFor,
  MeasureFor,
  FragmentFor,
} from "./registry/types";

/**
 * Block lookup entry for painter
 */
export type BlockLookupEntry = {
  block: FlowBlock;
  measure: Measure;
  version?: string;
};

/**
 * Block lookup map type
 */
export type BlockLookup = Map<string, BlockLookupEntry>;

/**
 * Painter options
 */
export type PainterOptions = {
  /** Document to create elements in */
  document?: Document;
  /** Gap between pages in pixels */
  pageGap?: number;
  /** Show page shadows */
  showShadow?: boolean;
  /** Background color for pages */
  pageBackground?: string;
  /** Container background color */
  containerBackground?: string;
  /**
   * Optional custom feature registry. Defaults to `createDefaultRegistry()`.
   * Pass a custom registry to swap or extend renderers without subclassing
   * `LayoutPainter`.
   */
  registry?: FeatureRegistry;
};

/**
 * Page DOM state for reconciliation
 */
type PageState = {
  element: HTMLElement;
  pageNumber: number;
  fragmentCount: number;
};

/**
 * Layout Painter class
 *
 * Renders Layout data to DOM with efficient reconciliation.
 * Only updates changed pages and fragments for better performance.
 */
export class LayoutPainter {
  private container: HTMLElement | null = null;
  private blockLookup: BlockLookup = new Map();
  private pageStates: PageState[] = [];
  private totalPages = 0;
  private options: PainterOptions;
  private doc: Document;
  private registry: FeatureRegistry;

  constructor(options: PainterOptions = {}) {
    this.options = options;
    this.doc = options.document ?? document;
    this.registry = options.registry ?? createDefaultRegistry();
  }

  /**
   * Set the block lookup map for rendering fragments
   */
  setBlockLookup(lookup: BlockLookup): void {
    this.blockLookup = lookup;
  }

  /**
   * Mount the painter to a container element
   */
  mount(container: HTMLElement): void {
    this.container = container;
    this.applyContainerStyles();
  }

  /**
   * Unmount the painter
   */
  unmount(): void {
    if (this.container) {
      this.container.innerHTML = "";
    }
    this.container = null;
    this.pageStates = [];
  }

  /**
   * Apply styles to the container
   */
  private applyContainerStyles(): void {
    if (!this.container) {
      return;
    }

    const pageGap = this.options.pageGap ?? 24;

    this.container.style.display = "flex";
    this.container.style.flexDirection = "column";
    this.container.style.alignItems = "center";
    this.container.style.gap = `${pageGap}px`;
    this.container.style.padding = `${pageGap}px`;
    this.container.style.backgroundColor =
      this.options.containerBackground ?? "var(--doc-bg, #f8f9fa)";
    this.container.style.minHeight = "100%";
  }

  /**
   * Paint a layout to the container
   */
  paint(layout: Layout): void {
    if (!this.container) {
      panic("LayoutPainter: not mounted");
    }

    const { pages } = layout;
    this.totalPages = pages.length;

    // Full repaint for now (reconciliation can be added later)
    this.container.innerHTML = "";
    this.pageStates = [];

    for (const i_item of pages) {
      const page = i_item;
      const context: RenderContext = {
        pageNumber: page.number,
        totalPages: this.totalPages,
        section: "body",
      };

      const pageEl = this.renderPageWithLookup(page, context);
      this.container.append(pageEl);

      this.pageStates.push({
        element: pageEl,
        pageNumber: page.number,
        fragmentCount: page.fragments.length,
      });
    }
  }

  /**
   * Render a page using block lookup for full fragment rendering
   */
  private renderPageWithLookup(
    page: Page,
    context: RenderContext,
  ): HTMLElement {
    const pageEl = this.doc.createElement("div");
    pageEl.className = "layout-page";
    pageEl.dataset["pageNumber"] = String(page.number);

    // Apply page styles
    pageEl.style.position = "relative";
    pageEl.style.width = `${page.size.w}px`;
    pageEl.style.height = `${page.size.h}px`;
    pageEl.style.backgroundColor =
      this.options.pageBackground ?? "var(--doc-canvas, #ffffff)";
    pageEl.style.color = "var(--doc-canvas-text, #1f2937)";
    pageEl.style.overflow = "hidden";

    // No page shadow — matches Stella PDF viewer

    // Create content area
    const contentEl = this.doc.createElement("div");
    contentEl.className = "layout-page-content";
    contentEl.style.position = "absolute";
    contentEl.style.top = `${page.margins.top}px`;
    contentEl.style.left = `${page.margins.left}px`;
    contentEl.style.right = `${page.margins.right}px`;
    contentEl.style.bottom = `${page.margins.bottom}px`;
    contentEl.style.overflow = "visible";

    // Render fragments
    for (const fragment of page.fragments) {
      const fragmentEl = this.renderFragmentWithLookup(fragment, context);
      this.applyFragmentPosition(fragmentEl, fragment);
      contentEl.append(fragmentEl);
    }

    pageEl.append(contentEl);
    return pageEl;
  }

  /**
   * Render a fragment via the feature-module registry. Dispatch is O(1)
   * keyed on `fragment.kind`; modules supply the actual render. Fragments
   * without a resolved block/measure or with an unregistered kind fall
   * back to the placeholder renderer (`renderFragment`).
   */
  private renderFragmentWithLookup(
    fragment: Fragment,
    context: RenderContext,
  ): HTMLElement {
    const lookup = this.blockLookup.get(String(fragment.blockId));
    return this.registry.render({
      fragment,
      block: lookup?.block,
      measure: lookup?.measure,
      context,
      doc: this.doc,
    });
  }

  /**
   * Apply positioning styles to a fragment element
   */
  private applyFragmentPosition(
    element: HTMLElement,
    fragment: Fragment,
  ): void {
    element.style.position = "absolute";
    element.style.left = `${fragment.x}px`;
    element.style.top = `${fragment.y}px`;
    element.style.width = `${fragment.width}px`;
    element.style.height = `${fragment.height}px`;
  }

  /**
   * Get the current page count
   */
  getPageCount(): number {
    return this.totalPages;
  }

  /**
   * Get a page element by index
   */
  getPageElement(index: number): HTMLElement | null {
    return this.pageStates[index]?.element ?? null;
  }

  /**
   * Scroll to a specific page
   */
  scrollToPage(pageNumber: number): void {
    const state = this.pageStates.find((s) => s.pageNumber === pageNumber);
    if (state?.element) {
      state.element.scrollIntoView({
        behavior: prefersReducedMotionBehavior(),
        block: "start",
      });
    }
  }
}

/**
 * Create a new LayoutPainter instance
 */
export function createPainter(options?: PainterOptions): LayoutPainter {
  return new LayoutPainter(options);
}
