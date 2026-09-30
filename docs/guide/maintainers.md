# Maintainer guide

Settings that live in GitHub rather than in files, written down here so they can be reviewed,
reproduced and checked (audit 2026-09-30, §37).

## Branch protection for `main`

`main` is protected by a **repository ruleset**. The ruleset below is the reference; apply it with
the GitHub CLI (needs admin rights on the repository):

```bash
gh api --method POST repos/deltatree/agentic-video-engine/rulesets --input - <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "required_signatures" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "check" },
          { "context": "smoke-npx" }
        ]
      }
    }
  ]
}
JSON
```

| Rule | Why |
|---|---|
| No deletion, no force push, linear history | The history of `main` is the release record. |
| Signed commits | Supply chain (story 16.6): every commit on `main` is attributable. |
| Pull request with one approval, stale approvals dismissed, last push approved | No unreviewed code, also not by agents. |
| Required checks `check` and `smoke-npx` (strict, branch up to date) | The jobs of `.github/workflows/ci.yml`: build, lint (including the examples), docs drift (`npm run check:docs`), licenses, all tests with coverage, npm package smoke test. |

Workflows that are **not** required checks: `benchmarks.yml` (nightly; the run fails on a
regression), `images.yml` (tags `v*`), `release.yml` (tags `v*`; dormant – OpenVideo is not published on npm for now, users build from source with
[SETUP.md](../../SETUP.md)) and `docs.yml` (pushes to `main`; publishes the TypeDoc API reference to GitHub Pages).

### Check that the settings are active

```bash
gh api repos/deltatree/agentic-video-engine/rulesets --jq '.[] | {id, name, enforcement}'
gh api repos/deltatree/agentic-video-engine/rules/branches/main --jq '[.[].type] | sort'
# expected: ["deletion","non_fast_forward","pull_request","required_linear_history","required_signatures","required_status_checks"]
```

When a CI job is renamed, update the `required_status_checks` above and the ruleset in the same
pull request; otherwise pull requests wait for a check that never reports.

## Other repository settings

| Setting | Value |
|---|---|
| Default branch | `main` |
| Merge methods | squash and rebase; no merge commits (linear history) |
| Actions permissions | workflows declare their own `permissions`; default token permission read-only |
| Secrets | none required; `NPM_TOKEN` only if npm publishing is ever turned on (`release.yml`); no long-lived cloud credentials |
| Dependabot | `.github/dependabot.yml` (npm, GitHub Actions, Docker) |
| Private vulnerability reporting | on; the reporting process is described in `SECURITY.md` |
| Pages | Active. Source "GitHub Actions" (`docs.yml` deploys to the environment `github-pages`); the API reference lives at `https://deltatree.github.io/agentic-video-engine/` |
