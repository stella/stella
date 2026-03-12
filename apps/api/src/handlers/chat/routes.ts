import Elysia from "elysia";

import { authMacro } from "@/api/lib/auth";

import {
  uploadContextFileBodySchema,
  uploadContextFileHandler,
} from "./upload-context-file";

export const chatRoute = new Elysia({ prefix: "/chat" })
  .use(authMacro)
  .guard({ validateAuth: true })
  .post(
    "/upload-context-file",
    async ({ body: { file } }) => await uploadContextFileHandler({ file }),
    { body: uploadContextFileBodySchema },
  );
