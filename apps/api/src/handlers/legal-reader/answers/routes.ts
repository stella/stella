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
  .get("/", listReaderAnswers.handler, {
    query: listReaderAnswers.config.query,
    permissions: listReaderAnswers.config.permissions,
    accountAccess: listReaderAnswers.config.accountAccess,
  })
  .post("/", createReaderAnswer.handler, {
    body: createReaderAnswer.config.body,
    permissions: createReaderAnswer.config.permissions,
    accountAccess: createReaderAnswer.config.accountAccess,
  })
  .post("/:answerId/messages", followUpReaderAnswer.handler, {
    params: followUpReaderAnswer.config.params,
    body: followUpReaderAnswer.config.body,
    permissions: followUpReaderAnswer.config.permissions,
    accountAccess: followUpReaderAnswer.config.accountAccess,
  })
  .post("/:answerId/regenerate", regenerateReaderAnswer.handler, {
    params: regenerateReaderAnswer.config.params,
    body: regenerateReaderAnswer.config.body,
    permissions: regenerateReaderAnswer.config.permissions,
    accountAccess: regenerateReaderAnswer.config.accountAccess,
  })
  .patch("/:answerId", updateReaderAnswer.handler, {
    params: updateReaderAnswer.config.params,
    body: updateReaderAnswer.config.body,
    permissions: updateReaderAnswer.config.permissions,
    accountAccess: updateReaderAnswer.config.accountAccess,
  })
  .delete("/:answerId", deleteReaderAnswer.handler, {
    params: deleteReaderAnswer.config.params,
    permissions: deleteReaderAnswer.config.permissions,
    accountAccess: deleteReaderAnswer.config.accountAccess,
  });
