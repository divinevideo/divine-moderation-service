import { describe, expect, it } from 'vitest';
import {
  applyForceProvider,
  shouldQueueHiveRecheck,
  HIVE_RECHECK_RATE_LIMIT_MS,
} from './report-trigger.mjs';

const SHA256 = 'a'.repeat(64);

describe('applyForceProvider', () => {
  it('returns env unchanged when metadata has no forceProvider', () => {
    const env = { PRIMARY_MODERATION_PROVIDER: 'manual-review', OTHER: 'x' };
    const result = applyForceProvider(env, { source: 'user-report' });
    expect(result).toBe(env);
  });

  it('returns env unchanged when metadata is null or undefined', () => {
    const env = { PRIMARY_MODERATION_PROVIDER: 'manual-review' };
    expect(applyForceProvider(env, null)).toBe(env);
    expect(applyForceProvider(env, undefined)).toBe(env);
  });

  it('overrides PRIMARY_MODERATION_PROVIDER when metadata.forceProvider is set', () => {
    const env = { PRIMARY_MODERATION_PROVIDER: 'manual-review', HIVE_API_KEY: 'k' };
    const result = applyForceProvider(env, { forceProvider: 'hiveai' });
    expect(result.PRIMARY_MODERATION_PROVIDER).toBe('hiveai');
    expect(result.HIVE_API_KEY).toBe('k');
  });

  it('does not mutate the original env', () => {
    const env = { PRIMARY_MODERATION_PROVIDER: 'manual-review' };
    applyForceProvider(env, { forceProvider: 'hiveai' });
    expect(env.PRIMARY_MODERATION_PROVIDER).toBe('manual-review');
  });

  it('rejects unknown providers (defends against arbitrary env injection)', () => {
    const env = { PRIMARY_MODERATION_PROVIDER: 'manual-review' };
    const result = applyForceProvider(env, { forceProvider: 'evil-provider; rm -rf /' });
    expect(result).toBe(env);
  });
});

describe('shouldQueueHiveRecheck', () => {
  function dbMockReturning(row) {
    return {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return row;
              },
            };
          },
        };
      },
    };
  }

  it('returns true when no prior hiveai moderation exists', async () => {
    const result = await shouldQueueHiveRecheck(dbMockReturning(null), SHA256);
    expect(result).toBe(true);
  });

  it('returns false when a hiveai moderation ran within the rate-limit window', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = await shouldQueueHiveRecheck(
      dbMockReturning({ moderated_at: recent }),
      SHA256
    );
    expect(result).toBe(false);
  });

  it('returns true when the prior hiveai moderation is older than the window', async () => {
    const old = new Date(Date.now() - HIVE_RECHECK_RATE_LIMIT_MS - 1000).toISOString();
    const result = await shouldQueueHiveRecheck(
      dbMockReturning({ moderated_at: old }),
      SHA256
    );
    expect(result).toBe(true);
  });

  it('returns true when D1 is unavailable (fail-open)', async () => {
    const failingDb = {
      prepare() {
        throw new Error('D1 down');
      },
    };
    const result = await shouldQueueHiveRecheck(failingDb, SHA256);
    expect(result).toBe(true);
  });
});
