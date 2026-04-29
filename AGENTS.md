# Repository Guidelines

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
