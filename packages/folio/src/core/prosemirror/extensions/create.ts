/**
 * Extension Factory Functions
 *
 * Creates extension instances from definitions.
 * Each factory returns a function that accepts options and returns an extension instance.
 */

import { Priority } from "./types";
import type {
  Extension,
  NodeExtension,
  MarkExtension,
  ExtensionDefinition,
  NodeExtensionDefinition,
  MarkExtensionDefinition,
  ExtensionContext,
  ExtensionRuntime,
} from "./types";

const copyOptions = (options: object): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    result[key] = value;
  }
  return result;
};

const mergeDefaultOptions = <TOptions extends Record<string, unknown>>(
  defaultOptions: TOptions,
  options: Partial<TOptions> | undefined,
): TOptions => ({
  ...defaultOptions,
  ...options,
});

const extensionHasDefaultOptions = <TOptions extends Record<string, unknown>>(
  def: ExtensionDefinition<TOptions>,
): def is Extract<
  ExtensionDefinition<TOptions>,
  { defaultOptions: TOptions }
> => def.defaultOptions !== undefined;

const nodeExtensionHasDefaultOptions = <
  TOptions extends Record<string, unknown>,
>(
  def: NodeExtensionDefinition<TOptions>,
): def is Extract<
  NodeExtensionDefinition<TOptions>,
  { defaultOptions: TOptions }
> => def.defaultOptions !== undefined;

const markExtensionHasDefaultOptions = <
  TOptions extends Record<string, unknown>,
>(
  def: MarkExtensionDefinition<TOptions>,
): def is Extract<
  MarkExtensionDefinition<TOptions>,
  { defaultOptions: TOptions }
> => def.defaultOptions !== undefined;

/**
 * Create a generic extension (plugins, commands, keymaps — no schema contribution)
 */
export function createExtension<
  TOptions extends Record<string, unknown> = Record<string, unknown>,
>(
  def: ExtensionDefinition<TOptions>,
): (options?: Partial<TOptions>) => Extension {
  return (options?: Partial<TOptions>): Extension => {
    if (extensionHasDefaultOptions(def)) {
      const mergedOptions = mergeDefaultOptions(def.defaultOptions, options);

      return {
        type: "extension",
        config: {
          name: def.name,
          priority: def.priority ?? Priority.Default,
          options: copyOptions(mergedOptions),
        },
        onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
          return def.onSchemaReady(ctx, mergedOptions);
        },
      };
    }

    const mergedOptions = options ?? {};
    return {
      type: "extension",
      config: {
        name: def.name,
        priority: def.priority ?? Priority.Default,
        options: copyOptions(mergedOptions),
      },
      onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
        return def.onSchemaReady(ctx, mergedOptions);
      },
    };
  };
}

/**
 * Create a node extension (contributes a NodeSpec to the schema)
 */
export function createNodeExtension<
  TOptions extends Record<string, unknown> = Record<string, unknown>,
>(
  def: NodeExtensionDefinition<TOptions>,
): (options?: Partial<TOptions>) => NodeExtension {
  return (options?: Partial<TOptions>): NodeExtension => {
    if (nodeExtensionHasDefaultOptions(def)) {
      const mergedOptions = mergeDefaultOptions(def.defaultOptions, options);
      const nodeSpec =
        typeof def.nodeSpec === "function"
          ? def.nodeSpec(mergedOptions)
          : def.nodeSpec;

      return {
        type: "node",
        config: {
          name: def.name,
          priority: def.priority ?? Priority.Default,
          options: copyOptions(mergedOptions),
          schemaNodeName: def.schemaNodeName,
          nodeSpec,
        },
        onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
          return def.onSchemaReady?.(ctx, mergedOptions) ?? {};
        },
      };
    }

    const mergedOptions = options ?? {};
    const nodeSpec =
      typeof def.nodeSpec === "function"
        ? def.nodeSpec(mergedOptions)
        : def.nodeSpec;

    return {
      type: "node",
      config: {
        name: def.name,
        priority: def.priority ?? Priority.Default,
        options: copyOptions(mergedOptions),
        schemaNodeName: def.schemaNodeName,
        nodeSpec,
      },
      onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
        return def.onSchemaReady?.(ctx, mergedOptions) ?? {};
      },
    };
  };
}

/**
 * Create a mark extension (contributes a MarkSpec to the schema)
 */
export function createMarkExtension<
  TOptions extends Record<string, unknown> = Record<string, unknown>,
>(
  def: MarkExtensionDefinition<TOptions>,
): (options?: Partial<TOptions>) => MarkExtension {
  return (options?: Partial<TOptions>): MarkExtension => {
    if (markExtensionHasDefaultOptions(def)) {
      const mergedOptions = mergeDefaultOptions(def.defaultOptions, options);
      const markSpec =
        typeof def.markSpec === "function"
          ? def.markSpec(mergedOptions)
          : def.markSpec;

      return {
        type: "mark",
        config: {
          name: def.name,
          priority: def.priority ?? Priority.Default,
          options: copyOptions(mergedOptions),
          schemaMarkName: def.schemaMarkName,
          markSpec,
        },
        onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
          return def.onSchemaReady?.(ctx, mergedOptions) ?? {};
        },
      };
    }

    const mergedOptions = options ?? {};
    const markSpec =
      typeof def.markSpec === "function"
        ? def.markSpec(mergedOptions)
        : def.markSpec;

    return {
      type: "mark",
      config: {
        name: def.name,
        priority: def.priority ?? Priority.Default,
        options: copyOptions(mergedOptions),
        schemaMarkName: def.schemaMarkName,
        markSpec,
      },
      onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
        return def.onSchemaReady?.(ctx, mergedOptions) ?? {};
      },
    };
  };
}
