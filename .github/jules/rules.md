Repository rules (must follow):

- Read AGENTS.md first.
- catalog.json is data: only append new entries or make minimal edits. Never reorder, reformat the file, or touch unrelated entries.
- Run `node scripts/validate-catalog.mjs` after any change; it must pass.
- Do not add dependencies. Do not change unrelated workflows or files.
- Use conventional commit messages (for example `fix(catalog): ...`).
- Open a PR only if you have concrete, verified changes. Put uncertain findings in the PR description instead of guessing.
- Never commit secrets, tokens, or local paths.
