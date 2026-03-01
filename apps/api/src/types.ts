import type { properties } from "@/api/db/schema";
import type * as SchemaValidators from "@/api/db/schema-validators";
import type { Registry as RegistryType } from "@/api/handlers/registry";
import type api from "@/api/index.js";

export type API = typeof api;
export type Registry = RegistryType;

export type PropertyTable = typeof properties.$inferSelect;
export type PropertyContent = SchemaValidators.PropertyContent;
export type PropertyContentType = SchemaValidators.PropertyContentType;

export type FieldContent = SchemaValidators.FieldContent;

export type OptionColor = SchemaValidators.OptionColor;

export type BoundingBox = SchemaValidators.BoundingBoxes["boxes"][number];

export type PropertyCondition = SchemaValidators.PropertyCondition;

export type EntityKind = SchemaValidators.EntityKind;
export type ViewLayout = SchemaValidators.ViewLayout;
export type ViewFilterCondition = SchemaValidators.ViewFilterCondition;
export type ViewConfig = SchemaValidators.ViewConfig;
