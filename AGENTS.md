# Repository instructions

- Shared product and classroom decisions: read `docs/CLASSROOM_DIRECTION.md`. The coordination chat owns cross-module integration; preserve other worktrees and existing user settings.

- Read ARCHITECTURE.md and README.md before changing teaching behavior.
- Python backend: `cd backend && uv run pytest -q && uv run ruff check app tests`.
- Frontend: `cd frontend && npm run typecheck && npm test`; build for meaningful UI changes.
- Browser integration: `cd frontend && npm run test:e2e` (dedicated data/e2e, ports 3100/8100).
- Never commit backend/.env or real student data. Never place provider keys in NEXT_PUBLIC variables.
- Keep TeachingPolicy separate from language generation. New mastery judgments need explicit evidence IDs and uncertainty.
- Demo mode must never claim live LLM calls or handwriting recognition. Mock responses cannot establish live-provider correctness.
- Cost values are estimates, usage may be provider-reported. Preserve uncertain cost reservations.
- Run one backend worker unless budget/state coordination is redesigned.
- tldraw has a proprietary SDK license. Do not remove its watermark, bypass validation, or claim all dependencies are MIT.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
