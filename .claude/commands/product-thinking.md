# Product Thinking

Assess a feature idea through a product lens before writing any
plan or code. This is a conversational exercise: no code changes,
no files produced. The output is clarity on whether and how to
build something.

## Arguments

$ARGUMENTS — A short description of the feature or problem area
to assess (e.g. "document versioning", "kanban views for matters",
"bulk import from iManage"). If empty, ask the user what they want
to think through.

## Philosophy

Two forces in tension:

1. **First principles are powerful.** Most software is shaped by
   historical accident, not intentional design. Rethinking from
   scratch often reveals dramatically simpler solutions.

2. **Path dependence is real.** Existing solutions evolved under
   constraints that are easy to underestimate. Switching costs
   are enormous. Dismissing the status quo as "inefficient" without
   understanding *why* it looks that way is what Edmund Schuster
   calls the junior business consultant fallacy: the uninspired
   finding that systems evolved over centuries are less efficiently
   designed than what a moderately talented designer could achieve
   starting from scratch. By adopting this approach one will, of
   course, find problems waiting to be solved behind every corner,
   but most of them are mirages.

The skill navigates this tension explicitly. Every "we should
rethink this" must survive a "why does the current solution exist?"
challenge, and vice versa.

## Instructions

Work through these phases in order. Use AskUserQuestion when
you need input; present concrete options with a recommendation.

Keep the conversation sharp. No filler. Lead with insights, not
process narration.

### Phase 0: Problem Statement

Before discussing solutions, nail the problem.

1. **What is the actual problem?** Not "we need feature X" but
   "users struggle with Y because Z." Force separation of problem
   from solution.
2. **Who feels this pain?** Be specific within our ICP (mid-size
   law firms, 5-50 lawyers; scaling path to Magic Circle). Is this
   a partner problem, an associate problem, a paralegal problem,
   an IT admin problem?
3. **How acute is the pain?** Daily friction vs. occasional
   annoyance vs. blocker that prevents adoption entirely.
4. **What happens if we do nothing?** Be honest. Some problems
   are real but tolerable. Others are existential.

Stop. Discuss with user.

### Phase 1: Status Quo Autopsy

Before proposing anything new, understand why the world looks
the way it does.

1. **How do law firms solve this today?** Not just with software;
   include manual processes, workarounds, "that's just how we do
   it" practices, or tolerating suboptimal solutions. These persist for reasons.
2. **Why did it evolve this way?** Map the path dependence.
   Regulatory requirements, professional norms, liability
   concerns, workflow inertia, training costs. Legal is
   conservative for reasons; understand them before dismissing
   them.
3. **What are the switching costs?** If firms already have a
   solution (even a bad one), what does migration look like?
   Data migration, retraining, workflow disruption, political
   resistance from partners who chose the current system.
4. **Schuster check:** Is our proposed improvement genuinely
   better *after accounting for switching costs* to the previous process,
   or are we just noticing that legacy systems are messy? Would a firm
   rationally switch, or only a firm starting from scratch?

Stop. Discuss with user.

### Phase 2: ICP Lens

Run the feature through Stella's actual customer profile.

1. **Mid-size firm reality check.** These firms are pragmatic
   and cost-conscious. They don't have dedicated IT teams. They
   care about reliability over features. Does this feature
   serve them, or does it serve our vision of what they should
   want?
2. **Magic Circle scaling check.** Does this feature's design
   block scaling to 2,000-5,000 lawyers? Not "does it scale
   technically" (that's for the plan) but "does the UX concept
   scale?" A feature designed for 10 users in a firm may be
   wrong for 2,000.
3. **International lens.** Our audience is international. Does
   this feature assume English? Common law? US/UK conventions?
   Consider: date formats, citation styles, legal terminology
   differences, regulatory variation across jurisdictions,
   right-to-left languages, document conventions (e.g. German
   legal documents look nothing like American ones).
4. **Buyer vs. user.** Who decides to adopt Stella (usually
   partners or IT) vs. who uses this feature daily (usually
   associates or staff)? Does this feature appeal to the
   buyer, the user, or both?

Stop. Discuss with user.

### Phase 3: Competition Scan

Two lenses: sector competitors solving the same domain problem,
and cross-sector products solving the same structural problem.

**In-sector (legal tech):**

1. How do existing legal software products solve this problem?
   What do they get right? What do users complain about?
2. What is the "table stakes" expectation? What must exist for
   a firm migrating from these tools?
3. Where is the gap we can exploit? (Usually: AI integration,
   modern UX, pricing, openness, or data sovereignty.)
4. Consider both classic legal software categories (DMS, practice management,
   e-billing) and newer categories (legal OS, legal knowledge
   graph, AI copilot). The best solution may come from an
   unexpected category.

**Cross-sector (structural analogs):**

1. What is the structural problem underneath the domain skin?
   (E.g., "document review" is structurally "collaborative
   annotation over a large corpus"; "matter management" is
   structurally "project management with compliance
   constraints".)
2. Who solves this structural problem best outside legal?
   (E.g., Figma for collaborative review, Linear for project
   management, Notion for knowledge organization, Airtable
   for structured data views.)
3. What can we learn? Not features; *interaction patterns*,
   *mental models*, *UX metaphors*. The best legal tech often
   imports ideas from tools lawyers have never seen.

Stop. Discuss with user.

### Phase 4: First Principles Rebuild

Now, and only now, rethink from scratch. The previous phases
gave you the constraints; this phase ignores them temporarily.

1. **Clean slate.** If no legal software existed and you were
   designing this capability today, what would it look like?
   Don't think about migration or compatibility. Think about
   the ideal experience.
2. **What would make this remarkable?** Not "adequate" or
   "competitive" but something a lawyer would tell a colleague
   about. What is the 10-star version? (Even if you ship the
   3-star version, knowing the 10-star version shapes your
   architecture.)
3. **What assumptions are we inheriting unnecessarily?** List
   assumptions baked into the current approach. Challenge each:
   is it a genuine constraint (regulation, physics, user
   expectation) or inherited convention?
4. **Reconcile with Phase 1.** Now bring back reality. Which
   parts of the clean-slate design survive contact with path
   dependence and switching costs? Which are worth the
   migration cost? Which should shape the long-term
   architecture even if we ship a compatible version first?

Stop. Discuss with user.

### Phase 5: Maintainability Filter

Run the surviving idea through a sustainability check.

1. **Complexity budget.** Every feature has an ongoing
   maintenance cost. Is this feature worth its carrying cost
   in perpetuity? A feature that requires constant tuning,
   monitoring, or edge-case handling may not be worth building
   even if the initial implementation is straightforward.
2. **Simplicity test.** Can you explain the entire feature's
   behaviour in 3 sentences? If not, it may be too complex for
   users too, not just for the team.
3. **Failure mode.** When this feature breaks (not if), what
   happens? Is the failure graceful, or does it block the
   user's core workflow? Features that degrade gracefully are
   cheaper to maintain than features that must be perfect.
4. **Scope creep forecast.** What will users inevitably ask for
   next? ("Can it also...?") Is the design extensible to those
   requests without a rewrite, or are you building a dead end?

Stop. Discuss with user.

### Phase 6: Verdict

Synthesise everything into a clear recommendation.

1. **Build / Reshape / Defer / Kill.**
   - **Build:** The feature is worth building roughly as
     conceived. Proceed to `/plan`.
   - **Reshape:** The core idea is sound but the approach needs
     significant rethinking. State what changes.
   - **Defer:** Not the right time. State what would change
     that (more customers, different market conditions, a
     prerequisite feature).
   - **Kill:** The feature is not worth building. State why
     clearly so the decision sticks and doesn't resurface
     every quarter.
2. **If Build or Reshape:** state the 3 most important
   constraints or principles that should carry into the plan.
   These become the plan's guardrails.
3. **One-line pitch.** If you had to sell this feature to a
   sceptical managing partner in one sentence, what would you
   say? If you can't, the feature isn't clear enough yet.
