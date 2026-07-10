# Repository Guidelines

## Divine Context And Brain

Before broad product, architecture, protocol, cross-repo, or service-boundary work, read the shared Divine context primer.

Use `DIVINE_CONTEXT_ROOT` if set; otherwise look for `../divine-context`. If it is missing, try:

`gh repo clone divinevideo/divine-context ../divine-context`

The `divine-context` repo is private, so cloning requires GitHub access. If clone, network, or auth fails, continue from the local repo docs and avoid cross-repo assumptions.

Before updating an existing context checkout, verify it is clean and on its default branch. If it is clean and on the default branch, update it with `git -C <context-dir> pull --ff-only`. If it is dirty, on another branch, cannot fast-forward, or network/auth fails, leave it untouched and say the context may be stale.

Read `<context-dir>/AGENT_CONTEXT.md` and follow its instructions. If unavailable, continue from the local repo docs and avoid cross-repo assumptions.

If a Divine Brain search or ask tool is available, you may use it for company memory. Treat it as optional and credentialed: tool names vary by client, and work must continue when Brain is unavailable. When Brain results influence work, cite the returned document ids. Never commit Brain credentials or expose Brain-derived sensitive content in public PRs, issues, branch names, commit messages, code comments, logs, screenshots, release notes, or externally shared agent transcripts.

## Project Structure & Module Organization
- Worker code lives under `src/`.
- Data and runtime configuration lives in `wrangler.toml`, `migrations/`, and supporting scripts under `scripts/`.
- Operational and product docs live in `README.md`, `CONTENT_MODERATION.md`, `CDN_INTEGRATION.md`, `CLOUDFLARE_ACCESS_SETUP.md`, `ADMIN_SETUP.md`, and `docs/`.
- Keep queue processing, moderation policy, admin endpoints, and relay integration changes scoped so they are easy to review.

## Build, Test, and Validation Commands
- `npm run lint`: custom repo lint pass.
- `npm test`: Vitest suite.
- `npm run dev`: local Worker development with Wrangler.
- `npm run deploy`: deploy the Worker. Use only when intentionally shipping changes.

## Coding Style & Naming Conventions
- Follow the existing TypeScript, Cloudflare Worker, and queue-processing patterns already established in the repo.
- Keep moderation policy changes, queue behavior changes, and admin/auth changes focused. Do not mix unrelated cleanup or refactors into the same PR.
- Verify URLs, relay endpoints, secrets, and bindings against `wrangler.toml` and the relevant docs before changing them. Do not hardcode environment-specific domains or secrets in application code.

## Security & Operational Notes
- Never commit secrets, API tokens, private keys, Cloudflare Access credentials, or screenshots/logs containing sensitive values.
- Public issues, PRs, branch names, screenshots, and descriptions must not mention corporate partners, customers, brands, campaign names, or other sensitive external identities unless a maintainer explicitly approves it. Use generic descriptors instead.
- Be explicit about any changes that affect moderation outcomes, quarantine decisions, admin auth, or relay publishing behavior.

## Pull Request Guardrails
- PR titles must use Conventional Commit format: `type(scope): summary` or `type: summary`.
- Set the correct PR title when opening the PR. Do not rely on fixing it later.
- If a PR title is edited after opening, verify that the semantic PR title check reruns successfully.
- Keep PRs tightly scoped. Do not include unrelated formatting churn, dependency noise, or drive-by refactors.
- Temporary or transitional code must include `TODO(#issue):` with a tracking issue.
- UI, admin, or externally visible API behavior changes should include screenshots, sample payloads, or an explicit note that there is no visual change.
- PR descriptions must include a summary, motivation, linked issue, and manual validation plan.
- Before requesting review, run the relevant checks for the files you changed, or note what you could not run.
