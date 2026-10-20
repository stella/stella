import Elysia from "elysia";

import createReaderAnswer from "@/api/handlers/legal-reader/answers/create";
import deleteReaderAnswer from "@/api/handlers/legal-reader/answers/delete";
import followUpReaderAnswer from "@/api/handlers/legal-reader/answers/follow-up";
import listReaderAnswers from "@/api/handlers/legal-reader/answers/list";
import regenerateReaderAnswer from "@/api/handlers/legal-reader/answers/regenerate";
import updateReaderAnswer from "@/api/handlers/legal-reader/answers/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { preventPublicCaching } from "@/api/lib/security-headers";

export const readerAnswersRoute = new Elysia({ prefix: "/answers" })
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW"),
    ),
  )
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .onBeforeHandle(({ set }) => preventPublicCaching(set))
  .get(
    "/",
    {
      query: listReaderAnswers.config.query,
      permissions: listReaderAnswers.config.permissions,
    },
    listReaderAnswers.handler,
  )
  .post(
    "/",
    {
      body: createReaderAnswer.config.body,
      permissions: createReaderAnswer.config.permissions,
    },
    createReaderAnswer.handler,
  )
  .post(
    "/:answerId/messages",
    {
      params: followUpReaderAnswer.config.params,
      body: followUpReaderAnswer.config.body,
      permissions: followUpReaderAnswer.config.permissions,
    },
    followUpReaderAnswer.handler,
  )
  .post(
    "/:answerId/regenerate",
    {
      params: regenerateReaderAnswer.config.params,
      body: regenerateReaderAnswer.config.body,
      permissions: regenerateReaderAnswer.config.permissions,
    },
    regenerateReaderAnswer.handler,
  )
  .patch(
    "/:answerId",
    {
      params: updateReaderAnswer.config.params,
      body: updateReaderAnswer.config.body,
      permissions: updateReaderAnswer.config.permissions,
    },
    updateReaderAnswer.handler,
  )
  .delete(
    "/:answerId",
    {
      params: deleteReaderAnswer.config.params,
      permissions: deleteReaderAnswer.config.permissions,
    },
    deleteReaderAnswer.handler,
  );
