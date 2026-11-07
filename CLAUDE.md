@AGENTS.md

## Claude Code notes

- `AGENTS.md` (imported above) is the canonical guide, and it imports the create-plugin instructions
  in `.config/AGENTS/instructions.md`. Put project knowledge in `AGENTS.md`, not here.
- Skills: `.claude/skills/build-plugin` and `.claude/skills/validate-plugin` (`/build-plugin`,
  `/validate-plugin`) import their steps from `.config/AGENTS/skills/*.md`, which create-plugin
  manages; `.codex/skills/` holds the same skills for Codex. Do not edit `.config/AGENTS/`; put
  project-specific build or validation notes in `AGENTS.md`.
