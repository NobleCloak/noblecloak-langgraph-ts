# Provenance

Staged from the NobleCloak authoring repository at `0620a1d3812ed121b5cfbf279addf832fff50a57` on 2026-10-29, with no git
history, by its staging script. Paths taken: `packages/adapters/langgraph` → `packages/langgraph`,
`examples/langgraph-approvals`, `packages/skills/langgraph` → `skills/langgraph`, the langgraph skill's
exercise scripts and test under `scripts/`, and `docs/snippets/adapter.ts`. The adapter's changelog
(`packages/langgraph/CHANGELOG.md`) carries its release history; the commit trail stays in the source repository.

Brought from the same source sha after staging, and cut to this repository: `scripts/pack-all.ts`,
`scripts/release.ts` and its test (a registry parameter and a name allowlist are new here), the helpers of
`scripts/skill-exercise.ts` as `scripts/skill-exercise-common.ts`, a `scripts/skill-compare.ts` reduced to the
langgraph skill's shape, `docs/snippets/sync-check.ts` and its test, and the adapter section of
`docs/how-to/first-governed-tool.md` as `docs/how-to/govern-a-langgraph-agent.md`. The two contract packages
were first vendored here as tarballs the staging script packed from a scratch build of the source at that sha;
they now install from the organisation's package registry at the versions `contract.json` records, and no
tarball of them is in the tree. The two repositories are not kept in step.
