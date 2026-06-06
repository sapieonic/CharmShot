/**
 * Conventional Commits rules (for local authoring / `npm run commitlint`).
 *
 * Releases are driven by commit messages: `feat:` → minor, `fix:` → patch,
 * `feat!:`/`BREAKING CHANGE:` → major. Because PRs are squash-merged, the PR
 * title becomes the commit on main — it is validated by the "PR Title" workflow.
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
};
