import "elysia";

export type { DocumentDecoration } from "elysia";

declare module "elysia" {
  interface DocumentDecoration {
    "x-stella-tenant-action"?: boolean;
  }
}
