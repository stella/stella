# .agents

Working directory for AI agents. Track planning, decisions, and
implementation progress here.

See [CLAUDE.md](../CLAUDE.md) for project guidelines.

## Structure

```
.agents/
├── plans/           # Timestamped implementation plans
├── justifications/  # Decision rationale (why we chose X over Y)
├── reports/         # Local investigation reports (gitignored)
└── scratch/         # Temporary notes, drafts, work-in-progress
```

## Conventions

- **Plans** focus on _what_ and _why_, not prescriptive implementation
  details. Use the collision-resistant timestamp format from the `/plan`
  skill: `YYYYMMDD-HHMMSS-feature.md`.
- **Justifications** record decisions that future contributors (or
  agents) might question. Include alternatives considered and why
  they were rejected.
- **Scratch** is ephemeral. Anything here can be deleted at any time.
