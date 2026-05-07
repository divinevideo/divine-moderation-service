// ABOUTME: Helpers for routing user reports to a per-message moderation provider override.
// Lets POST /api/v1/report (and the queue consumer) trigger Hive on incident only,
// instead of running Hive on every upload.

const ALLOWED_FORCE_PROVIDERS = new Set(['hiveai', 'sightengine']);

export const HIVE_RECHECK_RATE_LIMIT_MS = 6 * 60 * 60 * 1000;

export function applyForceProvider(env, metadata) {
  const requested = metadata?.forceProvider;
  if (!requested || !ALLOWED_FORCE_PROVIDERS.has(requested)) {
    return env;
  }
  return { ...env, PRIMARY_MODERATION_PROVIDER: requested };
}

export async function shouldQueueHiveRecheck(db, sha256, nowMs = Date.now()) {
  try {
    const row = await db
      .prepare(
        "SELECT moderated_at FROM moderation_results WHERE sha256 = ? AND provider = 'hiveai' ORDER BY moderated_at DESC LIMIT 1"
      )
      .bind(sha256)
      .first();

    if (!row?.moderated_at) {
      return true;
    }

    const lastMs = Date.parse(row.moderated_at);
    if (!Number.isFinite(lastMs)) {
      return true;
    }

    return nowMs - lastMs >= HIVE_RECHECK_RATE_LIMIT_MS;
  } catch {
    return true;
  }
}
