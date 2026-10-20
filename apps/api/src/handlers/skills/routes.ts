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
  .get(
    "/",
    {
      permissions: listSkills.config.permissions,
      query: listSkills.config.query,
    },
    listSkills.handler,
  )
  .get(
    "/commands",
    {
      permissions: listSkillCommands.config.permissions,
    },
    listSkillCommands.handler,
  )
  .get(
    "/:skillId",
    {
      params: getSkill.config.params,
      permissions: getSkill.config.permissions,
    },
    getSkill.handler,
  )
  .post(
    "/",
    {
      body: createSkill.config.body,
      permissions: createSkill.config.permissions,
    },
    createSkill.handler,
  )
  .post(
    "/from-blueprint",
    {
      body: fromBlueprint.config.body,
      permissions: fromBlueprint.config.permissions,
    },
    fromBlueprint.handler,
  )
  .post(
    "/upload",
    {
      body: uploadSkill.config.body,
      permissions: uploadSkill.config.permissions,
    },
    uploadSkill.handler,
  )
  .post(
    "/import-url",
    {
      body: importSkillFromUrl.config.body,
      permissions: importSkillFromUrl.config.permissions,
    },
    importSkillFromUrl.handler,
  )
  .post(
    "/discover-url",
    {
      body: discoverSkillUrl.config.body,
      permissions: discoverSkillUrl.config.permissions,
    },
    discoverSkillUrl.handler,
  )
  .post(
    "/import-urls",
    {
      body: importSkillsFromUrls.config.body,
      permissions: importSkillsFromUrls.config.permissions,
    },
    importSkillsFromUrls.handler,
  )
  .post(
    "/generate-draft",
    {
      body: generateSkillDraft.config.body,
      permissions: generateSkillDraft.config.permissions,
    },
    generateSkillDraft.handler,
  )
  .patch(
    "/:skillId",
    {
      body: updateSkill.config.body,
      params: updateSkill.config.params,
      permissions: updateSkill.config.permissions,
    },
    updateSkill.handler,
  )
  .patch(
    "/:skillId/resources",
    {
      body: updateSkillResource.config.body,
      params: updateSkillResource.config.params,
      permissions: updateSkillResource.config.permissions,
    },
    updateSkillResource.handler,
  )
  .post(
    "/:skillId/resources",
    {
      body: createSkillResource.config.body,
      params: createSkillResource.config.params,
      permissions: createSkillResource.config.permissions,
    },
    createSkillResource.handler,
  )
  .delete(
    "/:skillId/resources",
    {
      body: deleteSkillResource.config.body,
      params: deleteSkillResource.config.params,
      permissions: deleteSkillResource.config.permissions,
    },
    deleteSkillResource.handler,
  )
  .post(
    "/:skillId/resources/rename",
    {
      body: renameSkillResource.config.body,
      params: renameSkillResource.config.params,
      permissions: renameSkillResource.config.permissions,
    },
    renameSkillResource.handler,
  )
  .post(
    "/:skillId/resources/upload",
    {
      body: uploadSkillResource.config.body,
      params: uploadSkillResource.config.params,
      permissions: uploadSkillResource.config.permissions,
    },
    uploadSkillResource.handler,
  )
  .post(
    "/:skillId/resources/rewrite",
    {
      body: rewriteSkillResource.config.body,
      params: rewriteSkillResource.config.params,
      permissions: rewriteSkillResource.config.permissions,
    },
    rewriteSkillResource.handler,
  )
  .get(
    "/:skillId/revisions",
    {
      params: listSkillRevisions.config.params,
      permissions: listSkillRevisions.config.permissions,
    },
    listSkillRevisions.handler,
  )
  .get(
    "/:skillId/revisions/:revisionId",
    {
      params: getSkillRevision.config.params,
      permissions: getSkillRevision.config.permissions,
    },
    getSkillRevision.handler,
  )
  .get(
    "/:skillId/proposals",
    {
      params: listSkillProposals.config.params,
      permissions: listSkillProposals.config.permissions,
    },
    listSkillProposals.handler,
  )
  .get(
    "/:skillId/proposals/:proposalId",
    {
      params: getSkillProposal.config.params,
      permissions: getSkillProposal.config.permissions,
    },
    getSkillProposal.handler,
  )
  .post(
    "/:skillId/proposals",
    {
      body: createSkillProposal.config.body,
      params: createSkillProposal.config.params,
      permissions: createSkillProposal.config.permissions,
    },
    createSkillProposal.handler,
  )
  .post(
    "/:skillId/proposals/from-comments",
    {
      body: createSkillProposalFromComments.config.body,
      params: createSkillProposalFromComments.config.params,
      permissions: createSkillProposalFromComments.config.permissions,
    },
    createSkillProposalFromComments.handler,
  )
  .patch(
    "/:skillId/proposals/:proposalId",
    {
      body: updateSkillProposal.config.body,
      params: updateSkillProposal.config.params,
      permissions: updateSkillProposal.config.permissions,
    },
    updateSkillProposal.handler,
  )
  .post(
    "/:skillId/proposals/:proposalId/review",
    {
      body: reviewSkillProposal.config.body,
      params: reviewSkillProposal.config.params,
      permissions: reviewSkillProposal.config.permissions,
    },
    reviewSkillProposal.handler,
  )
  .delete(
    "/:skillId/proposals/:proposalId",
    {
      params: deleteSkillProposal.config.params,
      permissions: deleteSkillProposal.config.permissions,
    },
    deleteSkillProposal.handler,
  )
  .get(
    "/:skillId/comments",
    {
      params: listSkillComments.config.params,
      permissions: listSkillComments.config.permissions,
    },
    listSkillComments.handler,
  )
  .post(
    "/:skillId/comments",
    {
      body: createSkillComment.config.body,
      params: createSkillComment.config.params,
      permissions: createSkillComment.config.permissions,
    },
    createSkillComment.handler,
  )
  .patch(
    "/:skillId/comments/:commentId",
    {
      body: updateSkillComment.config.body,
      params: updateSkillComment.config.params,
      permissions: updateSkillComment.config.permissions,
    },
    updateSkillComment.handler,
  )
  .delete(
    "/:skillId/comments/:commentId",
    {
      params: deleteSkillComment.config.params,
      permissions: deleteSkillComment.config.permissions,
    },
    deleteSkillComment.handler,
  )
  .delete(
    "/:skillId",
    {
      params: deleteSkill.config.params,
      permissions: deleteSkill.config.permissions,
    },
    deleteSkill.handler,
  );
