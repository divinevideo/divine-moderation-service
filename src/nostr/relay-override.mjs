/**
 * `DM_RELAY_URLS` — the containment switch for outbound Nostr writes.
 *
 * Every path that signs with NOSTR_PRIVATE_KEY has to agree on what this
 * variable means, which is why it lives here rather than in the module that
 * happened to need it first. When dm-sender.mjs and publisher.mjs each parsed it
 * their own way, a TOML array made the DM path refuse to send while the kind-10050
 * path announced to three public aggregators — the exact harm, triggered by the
 * exact misconfiguration the refusal existed to catch.
 */

/** Publishing to more than this many relays is not more delivery, just more sockets. */
export const MAX_RELAYS = 5;

/**
 * Is this run declared contained?
 *
 * True whenever `DM_RELAY_URLS` is PRESENT, including when its value is unusable.
 * That is deliberate and is the direction that fails safe: an operator who set
 * the variable has said outbound writes must not leave a known list, so a value
 * we cannot parse means refuse, never "carry on as production".
 *
 * @param {Object} env
 * @returns {boolean}
 */
export function isContained(env) {
  const raw = env?.DM_RELAY_URLS;
  return raw !== undefined && raw !== null;
}

/**
 * The exact relay list for a contained run.
 *
 * Present but unusable THROWS. Setting this variable is a statement that writes
 * must not leave a known list, so falling back to the production defaults on a
 * bad value does the opposite of what was asked, and silently: there is no log
 * distinguishing a malformed value from an unset one. The case is not exotic —
 * `vars` in wrangler.toml accepts any JSON, so the natural TOML spelling
 *
 *     DM_RELAY_URLS = ["ws://127.0.0.1:4444"]
 *
 * deploys cleanly and arrives here as an array, not a string.
 *
 * Returning [] instead of throwing is not an option: zero relays reads downstream
 * as success===0 with no rejections, which sendModeratorMessage reports as a
 * non-definitive send, and the community-strike sweep then retains its warning
 * claim and never resends. A misconfiguration would silently swallow warnings.
 *
 * @param {Object} env
 * @returns {string[]} Relay URLs, deduped and capped at MAX_RELAYS; [] when unset
 * @throws {Error} when DM_RELAY_URLS is present but yields no usable relay
 */
export function parseRelayOverride(env) {
  if (!isContained(env)) return [];
  const raw = env.DM_RELAY_URLS;

  const parsed =
    typeof raw === 'string'
      ? raw.split(',').map((r) => r.trim()).filter(Boolean)
      : [];

  if (parsed.length === 0) {
    throw new Error(
      `DM_RELAY_URLS is set but yields no usable relay (${typeof raw}). ` +
        'Expected a comma-separated string of relay URLs. Refusing: falling back ' +
        'to the production relays would defeat the containment this setting ' +
        'exists to provide. Unset it to use production defaults.',
    );
  }

  // Dedupe BEFORE the cap. Capping first lets duplicates consume the budget and
  // silently drop a relay that was actually distinct, while the send path still
  // counts one success per socket -- so a single-relay delivery reports as
  // MAX_RELAYS-way redundancy.
  return [...new Set(parsed)].slice(0, MAX_RELAYS);
}
