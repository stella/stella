import type { properties } from "@/api/db/schema";
import type * as SchemaValidators from "@/api/db/schema-validators";
import type { Registry as RegistryType } from "@/api/handlers/registry";
import type * as ViewSchemas from "@/api/handlers/registry/actors/views/schema";
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
export type ViewLayout = ViewSchemas.ViewLayout;
export type ViewLayoutType = ViewSchemas.ViewLayoutType;
export type ViewFilterCondition = ViewSchemas.ViewFilterCondition;
