/**
 * Generic "scan the document for ranges" plugin factory.
 *
 * Folio's editor lives off-screen (HiddenProseMirror) and PM
 * decorations never reach the visible paged DOM. Features that
 * need to paint over spans of text (anonymization highlights,
 * template-directive widgets) therefore keep a list of
 * `{ from, to, ... }` ranges in plugin state and let a paged-canvas
 * overlay project them through `selectionToRects`. This factory
 * owns that "hold ranges, rescan on doc change" half so each
 * feature only supplies its own `scan(doc, config)`.
 *
 * `config` is the scan input: the term list for anonymization, or
 * `undefined` for directive scanning (the document text is the only
 * input). Push a new config via {@link setDocScanConfigMeta}; the
 * plugin rescans on that and on every `docChanged` transaction.
 */

import type { Node as PMNode } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import type { EditorState, PluginKey, PluginSpec } from "prosemirror-state";

const SET_META = "set";

export type DocScanState<TConfig, TRange> = {
  config: TConfig;
  ranges: readonly TRange[];
};

export type DocScanPluginOptions<TConfig, TRange> = {
  key: PluginKey<DocScanState<TConfig, TRange>>;
  initialConfig: TConfig;
  /** Recompute the ranges from the current doc + config. */
  scan: (doc: PMNode, config: TConfig) => TRange[];
  /**
   * Push-side bridge for hosts that mirror the current range list
   * outside the PM state tree (counters, inspector facets). Called
   * on init, after every transaction that changes the range set,
   * and on teardown (with an empty list).
   */
  onRangesChange?: (ranges: readonly TRange[]) => void;
};

export const createDocScanPlugin = <TConfig, TRange>({
  key,
  initialConfig,
  scan,
  onRangesChange,
}: DocScanPluginOptions<TConfig, TRange>): Plugin<
  DocScanState<TConfig, TRange>
> => {
  const spec: PluginSpec<DocScanState<TConfig, TRange>> = {
    key,
    state: {
      init(_config, instance): DocScanState<TConfig, TRange> {
        return {
          config: initialConfig,
          ranges: scan(instance.doc, initialConfig),
        };
      },
      apply(tr, prev, _oldState, newState): DocScanState<TConfig, TRange> {
        const setMeta = tr.getMeta(key) as
          | { type: typeof SET_META; config: TConfig }
          | undefined;

        if (setMeta?.type === SET_META) {
          return {
            config: setMeta.config,
            ranges: scan(newState.doc, setMeta.config),
          };
        }

        if (tr.docChanged) {
          // Doc edits move text around; rebuild ranges from scratch
          // rather than map regex offsets through a position mapping.
          return {
            config: prev.config,
            ranges: scan(newState.doc, prev.config),
          };
        }
        return prev;
      },
    },
  };

  if (onRangesChange) {
    spec.view = (view) => {
      let last = key.getState(view.state)?.ranges;
      if (last) {
        onRangesChange(last);
      }
      return {
        update(updatedView) {
          const next = key.getState(updatedView.state)?.ranges;
          if (next && next !== last) {
            last = next;
            onRangesChange(next);
          }
        },
        destroy() {
          onRangesChange([]);
        },
      };
    };
  }

  return new Plugin<DocScanState<TConfig, TRange>>(spec);
};

export const setDocScanConfigMeta = <TConfig, TRange>(
  key: PluginKey<DocScanState<TConfig, TRange>>,
  config: TConfig,
): {
  key: PluginKey<DocScanState<TConfig, TRange>>;
  payload: { type: typeof SET_META; config: TConfig };
} => ({ key, payload: { type: SET_META, config } });

export const getDocScanRanges = <TConfig, TRange>(
  key: PluginKey<DocScanState<TConfig, TRange>>,
  state: EditorState,
): readonly TRange[] => key.getState(state)?.ranges ?? [];
