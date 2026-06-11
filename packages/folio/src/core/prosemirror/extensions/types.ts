/**
 * Extension System Type Definitions
 *
 * Tiptap-style extension architecture for ProseMirror.
 * Three extension types:
 * - Extension: plugins, commands, keymaps (no schema)
 * - NodeExtension: adds a node spec to the schema
 * - MarkExtension: adds a mark spec to the schema
 */

import type { Schema, NodeSpec, MarkSpec } from "prosemirror-model";
import type { Plugin as PMPlugin, Command } from "prosemirror-state";

// ============================================================================
// PRIORITY
// ============================================================================

export type ExtensionPriority = number;

export const Priority = {
  Highest: 0,
  High: 50,
  Default: 100,
  Low: 150,
  Lowest: 200,
} as const;

// ============================================================================
// CONTEXT & RUNTIME
// ============================================================================

export type ExtensionContext = {
  schema: Schema;
};

// oxlint-disable-next-line typescript/no-explicit-any -- runtime boundary; individual commands carry their own typed signatures
export type CommandMap = Record<string, (...args: any[]) => Command>;
export type KeyboardShortcutMap = Record<string, Command>;

export type ExtensionRuntime = {
  commands?: CommandMap;
  keyboardShortcuts?: KeyboardShortcutMap;
  plugins?: PMPlugin[];
};

// ============================================================================
// EXTENSION CONFIGS
// ============================================================================

export type ExtensionConfig = {
  name: string;
  priority: ExtensionPriority;
  options: Record<string, unknown>;
};

export type NodeExtensionConfig = {
  schemaNodeName: string;
  nodeSpec: NodeSpec;
} & ExtensionConfig;

export type MarkExtensionConfig = {
  schemaMarkName: string;
  markSpec: MarkSpec;
} & ExtensionConfig;

// ============================================================================
// EXTENSION INSTANCES
// ============================================================================

export type Extension = {
  type: "extension";
  config: ExtensionConfig;
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime;
};

export type NodeExtension = {
  type: "node";
  config: NodeExtensionConfig;
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime;
};

export type MarkExtension = {
  type: "mark";
  config: MarkExtensionConfig;
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime;
};

export type AnyExtension = Extension | NodeExtension | MarkExtension;

// ============================================================================
// DEFINITION TYPES (used by factory functions)
// ============================================================================

type ExtensionOptions = Record<string, unknown>;

type ExtensionDefinitionWithDefaults<TOptions extends ExtensionOptions> = {
  name: string;
  priority?: ExtensionPriority;
  defaultOptions: TOptions;
  onSchemaReady(ctx: ExtensionContext, options: TOptions): ExtensionRuntime;
};

type ExtensionDefinitionWithoutDefaults<
  TOptions extends ExtensionOptions = ExtensionOptions,
> = {
  name: string;
  priority?: ExtensionPriority;
  defaultOptions?: undefined;
  onSchemaReady(
    ctx: ExtensionContext,
    options: Partial<TOptions>,
  ): ExtensionRuntime;
};

export type ExtensionDefinition<
  TOptions extends ExtensionOptions = ExtensionOptions,
> =
  | ExtensionDefinitionWithDefaults<TOptions>
  | ExtensionDefinitionWithoutDefaults<TOptions>;

type NodeExtensionDefinitionWithDefaults<TOptions extends ExtensionOptions> = {
  name: string;
  priority?: ExtensionPriority;
  defaultOptions: TOptions;
  schemaNodeName: string;
  nodeSpec: NodeSpec | ((options: TOptions) => NodeSpec);
  onSchemaReady?(ctx: ExtensionContext, options: TOptions): ExtensionRuntime;
};

type NodeExtensionDefinitionWithoutDefaults<
  TOptions extends ExtensionOptions = ExtensionOptions,
> = {
  name: string;
  priority?: ExtensionPriority;
  defaultOptions?: undefined;
  schemaNodeName: string;
  nodeSpec: NodeSpec | ((options: Partial<TOptions>) => NodeSpec);
  onSchemaReady?(
    ctx: ExtensionContext,
    options: Partial<TOptions>,
  ): ExtensionRuntime;
};

export type NodeExtensionDefinition<
  TOptions extends ExtensionOptions = ExtensionOptions,
> =
  | NodeExtensionDefinitionWithDefaults<TOptions>
  | NodeExtensionDefinitionWithoutDefaults<TOptions>;

type MarkExtensionDefinitionWithDefaults<TOptions extends ExtensionOptions> = {
  name: string;
  priority?: ExtensionPriority;
  defaultOptions: TOptions;
  schemaMarkName: string;
  markSpec: MarkSpec | ((options: TOptions) => MarkSpec);
  onSchemaReady?(ctx: ExtensionContext, options: TOptions): ExtensionRuntime;
};

type MarkExtensionDefinitionWithoutDefaults<
  TOptions extends ExtensionOptions = ExtensionOptions,
> = {
  name: string;
  priority?: ExtensionPriority;
  defaultOptions?: undefined;
  schemaMarkName: string;
  markSpec: MarkSpec | ((options: Partial<TOptions>) => MarkSpec);
  onSchemaReady?(
    ctx: ExtensionContext,
    options: Partial<TOptions>,
  ): ExtensionRuntime;
};

export type MarkExtensionDefinition<
  TOptions extends ExtensionOptions = ExtensionOptions,
> =
  | MarkExtensionDefinitionWithDefaults<TOptions>
  | MarkExtensionDefinitionWithoutDefaults<TOptions>;
