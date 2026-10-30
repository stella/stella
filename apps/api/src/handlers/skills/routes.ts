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
import { skillSourceBudget } from "@/api/handlers/skills/source-rate-limit";
import updateSkill from "@/api/handlers/skills/update";
import uploadSkill from "@/api/handlers/skills/upload";
import { mount, routes } from "@/api/http/route";

export const skillsRoute = mount(
  [
    // Fetching a skill from a URL reaches out to the internet.
    routes(
      {
        "/import-url": { POST: importSkillFromUrl },
        "/discover-url": { POST: discoverSkillUrl },
        "/import-urls": { POST: importSkillsFromUrls },
      },
      { middleware: [skillSourceBudget] },
    ),
    routes({
      "/": { GET: listSkills, POST: createSkill },
      "/commands": { GET: listSkillCommands },
      "/:skillId": { GET: getSkill, PATCH: updateSkill, DELETE: deleteSkill },
      "/from-blueprint": { POST: fromBlueprint },
      "/upload": { POST: uploadSkill },
      "/generate-draft": { POST: generateSkillDraft },
      "/:skillId/resources": {
        PATCH: updateSkillResource,
        POST: createSkillResource,
        DELETE: deleteSkillResource,
      },
      "/:skillId/resources/rename": { POST: renameSkillResource },
      "/:skillId/resources/upload": { POST: uploadSkillResource },
      "/:skillId/resources/rewrite": { POST: rewriteSkillResource },
      "/:skillId/revisions": { GET: listSkillRevisions },
      "/:skillId/revisions/:revisionId": { GET: getSkillRevision },
      "/:skillId/proposals": {
        GET: listSkillProposals,
        POST: createSkillProposal,
      },
      "/:skillId/proposals/:proposalId": {
        GET: getSkillProposal,
        PATCH: updateSkillProposal,
        DELETE: deleteSkillProposal,
      },
      "/:skillId/proposals/from-comments": {
        POST: createSkillProposalFromComments,
      },
      "/:skillId/proposals/:proposalId/review": { POST: reviewSkillProposal },
      "/:skillId/comments": {
        GET: listSkillComments,
        POST: createSkillComment,
      },
      "/:skillId/comments/:commentId": {
        PATCH: updateSkillComment,
        DELETE: deleteSkillComment,
      },
    }),
  ],
  { prefix: "/skills" },
);
