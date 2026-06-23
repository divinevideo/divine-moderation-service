// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared Blossom admin client. Called from the moderator-action pipeline and the creator-delete pipeline.
// ABOUTME: Maps internal action names to Blossom-understood actions and POSTs to BLOSSOM_WEBHOOK_URL with Bearer auth.

// Blossom states: Active/Restricted/Pending/Banned/Deleted plus AgeRestricted.
// Its /admin/moderate webhook handler maps actions to states:
//   SAFE/APPROVE → Active, RESTRICT/QUARANTINE → Restricted (404 to everyone but
//   the owner), AGE_RESTRICTED → AgeRestricted, PERMANENT_BAN → Banned, DELETE → Deleted.
// IMPORTANT: AgeRestricted is an auth-gate, not a withhold — it serves full bytes
// to ANY signed-in viewer (only anonymous requests get 401). To actually hide
// content (e.g. age-review restriction) use QUARANTINE → Restricted, which is
// reversible (back to Active via SAFE/APPROVE).
// REVIEW is internal only — content stays publicly accessible.
const BLOSSOM_ACTION_MAP = {
  'SAFE': 'SAFE',
  'AGE_RESTRICTED': 'AGE_RESTRICTED',
  'PERMANENT_BAN': 'PERMANENT_BAN',
  'QUARANTINE': 'RESTRICT',
  'DELETE': 'DELETE'
};

/**
 * Notify divine-blossom of a moderation decision or creator-initiated delete via webhook.
 * @param {string} sha256 - The blob hash
 * @param {string} action - Internal action (SAFE, REVIEW, QUARANTINE, AGE_RESTRICTED, PERMANENT_BAN, DELETE)
 * @param {Object} env - Environment with BLOSSOM_WEBHOOK_URL and BLOSSOM_WEBHOOK_SECRET
 * @returns {Promise<{success: boolean, error?: string, skipped?: boolean, result?: any, status?: number, networkError?: boolean}>}
 */
export async function notifyBlossom(sha256, action, env) {
  if (!env.BLOSSOM_WEBHOOK_URL) {
    console.log('[BLOSSOM] Webhook not configured, skipping notification');
    return { success: true, skipped: true };
  }

  const blossomAction = BLOSSOM_ACTION_MAP[action];
  if (!blossomAction) {
    console.log(`[BLOSSOM] Skipping notification for internal action: ${action}`);
    return { success: true, skipped: true };
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (env.BLOSSOM_WEBHOOK_SECRET) {
      headers['Authorization'] = `Bearer ${env.BLOSSOM_WEBHOOK_SECRET}`;
    }

    console.log(`[BLOSSOM] Notifying blossom of ${action} (as ${blossomAction}) for ${sha256}`);

    const response = await fetch(env.BLOSSOM_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sha256,
        action: blossomAction,
        timestamp: new Date().toISOString()
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[BLOSSOM] Webhook failed: ${response.status} - ${errorText}`);
      return { success: false, error: `HTTP ${response.status}: ${errorText}`, status: response.status };
    }

    const result = await response.json();
    console.log(`[BLOSSOM] Webhook succeeded for ${sha256}:`, result);
    return { success: true, result, status: response.status };

  } catch (error) {
    console.error(`[BLOSSOM] Webhook error for ${sha256}:`, error);
    return { success: false, error: error.message, networkError: true };
  }
}

export { BLOSSOM_ACTION_MAP };
