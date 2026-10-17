import "elysia/types";

export type { DocumentDecoration } from "elysia/types";

declare module "elysia/types" {
  interface DocumentDecoration {
    "x-stella-tenant-action"?: boolean;
  }
}
