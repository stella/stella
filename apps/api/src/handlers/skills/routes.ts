import Elysia from "elysia";

import listSkillCommands from "@/api/handlers/skills/commands/list";
import createSkillComment from "@/api/handlers/skills/comments/create";
import deleteSkillComment from "@/api/handlers/skills/comments/delete";
import listSkillComments from "@/api/handlers/skills/comments/list";
import updateSkillComment from "@/api/handlers/skills/comments/update";
import createSkill from "@/api/handlers/skills/create";
import deleteSkill from "@/api/handlers/skills/delete";
import discoverSkillUrl from "@/api/handlers/skills/discover";
import generateSkillDraft from "@/api/handlers/skills/drafts/generate";
import fromBlueprint from "@/api/handlers/skills/from-blueprint/create";
import importSkillFromUrl from "@/api/handlers/skills/from-url/import";
import getSkill from "@/api/handlers/skills/get";
import importSkillsFromUrls from "@/api/handlers/skills/import";
import listSkills from "@/api/handlers/skills/list";
import createSkillProposal from "@/api/handlers/skills/proposals/create";
import deleteSkillProposal from "@/api/handlers/skills/proposals/delete";
import createSkillProposalFromComments from "@/api/handlers/skills/proposals/from-comments/create";
import getSkillProposal from "@/api/handlers/skills/proposals/get";
import listSkillProposals from "@/api/handlers/skills/proposals/list";
import reviewSkillProposal from "@/api/handlers/skills/proposals/review";
import updateSkillProposal from "@/api/handlers/skills/proposals/update";
import createSkillResource from "@/api/handlers/skills/resources/create";
import deleteSkillResource from "@/api/handlers/skills/resources/delete";
import renameSkillResource from "@/api/handlers/skills/resources/rename";
import rewriteSkillResource from "@/api/handlers/skills/resources/rewrite";
import updateSkillResource from "@/api/handlers/skills/resources/update";
import uploadSkillResource from "@/api/handlers/skills/resources/upload";
import getSkillRevision from "@/api/handlers/skills/revisions/get";
import listSkillRevisions from "@/api/handlers/skills/revisions/list";
import {
  isSkillSourceRateLimitedRequest,
  skillSourceRateLimitBinding,
} from "@/api/handlers/skills/source-rate-limit";
import updateSkill from "@/api/handlers/skills/update";
import uploadSkill from "@/api/handlers/skills/upload";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";

export const skillsRoute = new Elysia({ prefix: "/skills" })
  .use(authMacro)
  .use(permissionMacro)
  .use(
    rateLimit({
      duration: API_RATE_LIMITS.skillSource.duration,
      max: API_RATE_LIMITS.skillSource.max,
      ...skillSourceRateLimitBinding,
      skip: (request) => !isSkillSourceRateLimitedRequest(request),
    }),
  )
  .guard({ validateAuth: true })
  .get("/", listSkills.handler, {
    permissions: listSkills.config.permissions,
    query: listSkills.config.query,
  })
  .get("/commands", listSkillCommands.handler, {
    permissions: listSkillCommands.config.permissions,
  })
  .get("/:skillId", getSkill.handler, {
    params: getSkill.config.params,
    permissions: getSkill.config.permissions,
  })
  .post("/", createSkill.handler, {
    body: createSkill.config.body,
    permissions: createSkill.config.permissions,
  })
  .post("/from-blueprint", fromBlueprint.handler, {
    body: fromBlueprint.config.body,
    permissions: fromBlueprint.config.permissions,
  })
  .post("/upload", uploadSkill.handler, {
    body: uploadSkill.config.body,
    permissions: uploadSkill.config.permissions,
  })
  .post("/import-url", importSkillFromUrl.handler, {
    body: importSkillFromUrl.config.body,
    permissions: importSkillFromUrl.config.permissions,
  })
  .post("/discover-url", discoverSkillUrl.handler, {
    body: discoverSkillUrl.config.body,
    permissions: discoverSkillUrl.config.permissions,
  })
  .post("/import-urls", importSkillsFromUrls.handler, {
    body: importSkillsFromUrls.config.body,
    permissions: importSkillsFromUrls.config.permissions,
  })
  .post("/generate-draft", generateSkillDraft.handler, {
    body: generateSkillDraft.config.body,
    permissions: generateSkillDraft.config.permissions,
  })
  .patch("/:skillId", updateSkill.handler, {
    body: updateSkill.config.body,
    params: updateSkill.config.params,
    permissions: updateSkill.config.permissions,
  })
  .patch("/:skillId/resources", updateSkillResource.handler, {
    body: updateSkillResource.config.body,
    params: updateSkillResource.config.params,
    permissions: updateSkillResource.config.permissions,
  })
  .post("/:skillId/resources", createSkillResource.handler, {
    body: createSkillResource.config.body,
    params: createSkillResource.config.params,
    permissions: createSkillResource.config.permissions,
  })
  .delete("/:skillId/resources", deleteSkillResource.handler, {
    body: deleteSkillResource.config.body,
    params: deleteSkillResource.config.params,
    permissions: deleteSkillResource.config.permissions,
  })
  .post("/:skillId/resources/rename", renameSkillResource.handler, {
    body: renameSkillResource.config.body,
    params: renameSkillResource.config.params,
    permissions: renameSkillResource.config.permissions,
  })
  .post("/:skillId/resources/upload", uploadSkillResource.handler, {
    body: uploadSkillResource.config.body,
    params: uploadSkillResource.config.params,
    permissions: uploadSkillResource.config.permissions,
  })
  .post("/:skillId/resources/rewrite", rewriteSkillResource.handler, {
    body: rewriteSkillResource.config.body,
    params: rewriteSkillResource.config.params,
    permissions: rewriteSkillResource.config.permissions,
  })
  .get("/:skillId/revisions", listSkillRevisions.handler, {
    params: listSkillRevisions.config.params,
    permissions: listSkillRevisions.config.permissions,
  })
  .get("/:skillId/revisions/:revisionId", getSkillRevision.handler, {
    params: getSkillRevision.config.params,
    permissions: getSkillRevision.config.permissions,
  })
  .get("/:skillId/proposals", listSkillProposals.handler, {
    params: listSkillProposals.config.params,
    permissions: listSkillProposals.config.permissions,
  })
  .get("/:skillId/proposals/:proposalId", getSkillProposal.handler, {
    params: getSkillProposal.config.params,
    permissions: getSkillProposal.config.permissions,
  })
  .post("/:skillId/proposals", createSkillProposal.handler, {
    body: createSkillProposal.config.body,
    params: createSkillProposal.config.params,
    permissions: createSkillProposal.config.permissions,
  })
  .post(
    "/:skillId/proposals/from-comments",
    createSkillProposalFromComments.handler,
    {
      body: createSkillProposalFromComments.config.body,
      params: createSkillProposalFromComments.config.params,
      permissions: createSkillProposalFromComments.config.permissions,
    },
  )
  .patch("/:skillId/proposals/:proposalId", updateSkillProposal.handler, {
    body: updateSkillProposal.config.body,
    params: updateSkillProposal.config.params,
    permissions: updateSkillProposal.config.permissions,
  })
  .post("/:skillId/proposals/:proposalId/review", reviewSkillProposal.handler, {
    body: reviewSkillProposal.config.body,
    params: reviewSkillProposal.config.params,
    permissions: reviewSkillProposal.config.permissions,
  })
  .delete("/:skillId/proposals/:proposalId", deleteSkillProposal.handler, {
    params: deleteSkillProposal.config.params,
    permissions: deleteSkillProposal.config.permissions,
  })
  .get("/:skillId/comments", listSkillComments.handler, {
    params: listSkillComments.config.params,
    permissions: listSkillComments.config.permissions,
  })
  .post("/:skillId/comments", createSkillComment.handler, {
    body: createSkillComment.config.body,
    params: createSkillComment.config.params,
    permissions: createSkillComment.config.permissions,
  })
  .patch("/:skillId/comments/:commentId", updateSkillComment.handler, {
    body: updateSkillComment.config.body,
    params: updateSkillComment.config.params,
    permissions: updateSkillComment.config.permissions,
  })
  .delete("/:skillId/comments/:commentId", deleteSkillComment.handler, {
    params: deleteSkillComment.config.params,
    permissions: deleteSkillComment.config.permissions,
  })
  .delete("/:skillId", deleteSkill.handler, {
    params: deleteSkill.config.params,
    permissions: deleteSkill.config.permissions,
  });
