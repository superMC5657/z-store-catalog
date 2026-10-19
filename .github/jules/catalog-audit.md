Audit the semantic quality of catalog.json. Schema and format validation is already handled by `scripts/validate-catalog.mjs`; focus on facts a validator cannot check:

1. GitHub repositories that are archived, deleted, renamed, or transferred (the `owner/repo` no longer resolves or redirects).
2. Clearly wrong categories, using `CATEGORIES` in `scripts/lib/catalog-shared.mjs` as the source of truth.
3. `description` / `description_en` that clearly no longer match the upstream repository.
4. `platforms` / `identifiers` that conflict with the actual release assets (for example, a repository with no Windows build marked as `windows`).

Make minimal, well-supported edits only. Put uncertain findings in the PR description without changing the file. If nothing actionable is found, do not open a PR.
