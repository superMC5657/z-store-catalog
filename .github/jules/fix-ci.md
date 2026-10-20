Reproduce and fix the current CI failure on `main`:

- Start with `node scripts/validate-catalog.mjs`.
- Change the smallest surface that fixes the root cause.
- Do not make CI green by deleting catalog entries or weakening validation rules.
- Explain the root cause and the fix in the PR description.
