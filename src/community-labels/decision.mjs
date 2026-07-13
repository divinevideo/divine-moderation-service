// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Pure decision logic for community content-warning aggregation.
// ABOUTME: No I/O — this module is the seam that an Osprey rule replaces later.

const NAMESPACE = 'content-warning';

// Known content-warning vocabulary, mirroring the mobile ContentLabel enum.
export const KNOWN_LABELS = new Set([
  'nudity', 'sexual', 'porn', 'graphic-media', 'violence', 'self-harm',
  'drugs', 'alcohol', 'tobacco', 'gambling', 'profanity', 'hate',
  'harassment', 'flashing-lights', 'ai-generated', 'deepfake', 'spam',
  'scam', 'spoiler', 'misleading', 'content-warning',
]);

const ALIASES = {
  'sexual-content': 'sexual',
  'pornography': 'porn',
  'explicit': 'porn',
  'graphic-violence': 'graphic-media',
  'gore': 'graphic-media',
  'nsfw': 'nudity',
  'offensive': 'hate',
  'hate-speech': 'hate',
  'recreational-drug': 'drugs',
  'weapon': 'violence',
};

/**
 * Normalize a label value to the known vocabulary, or null when it does not
 * map — community votes may only surface known labels.
 */
export function normalizeLabel(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const cleaned = value.trim().toLowerCase().replaceAll('_', '-').replace(/\s+/g, '-');
  const canonical = ALIASES[cleaned] ?? cleaned;
  return KNOWN_LABELS.has(canonical) ? canonical : null;
}

/**
 * Group votes by normalized label -> distinct author pubkeys, excluding the
 * video creator's own events and the moderation account's events.
 */
export function extractVotes(labelEvents, { moderationPubkey, creatorPubkey }) {
  const votesByLabel = new Map();
  for (const event of labelEvents) {
    if (!event || event.pubkey === moderationPubkey || event.pubkey === creatorPubkey) continue;
    for (const tag of event.tags ?? []) {
      if (!Array.isArray(tag) || tag.length < 3 || tag[0] !== 'l' || tag[2] !== NAMESPACE) continue;
      const label = normalizeLabel(tag[1]);
      if (label === null) continue;
      if (!votesByLabel.has(label)) votesByLabel.set(label, new Set());
      votesByLabel.get(label).add(event.pubkey);
    }
  }
  return votesByLabel;
}

/**
 * Labels whose distinct Divine-identity author count reached the threshold.
 * Returns [{ label, voteCount }].
 */
export function decideCrossings(votesByLabel, divineByAuthor, threshold) {
  const crossings = [];
  for (const [label, authors] of votesByLabel) {
    let divineCount = 0;
    for (const author of authors) {
      if (divineByAuthor.get(author) === true) divineCount += 1;
    }
    if (divineCount >= threshold) {
      crossings.push({ label, voteCount: divineCount });
    }
  }
  return crossings;
}

/**
 * Content-warning labels the creator applied on the video event itself,
 * normalized: NIP-32 self-labels plus bare content-warning tags.
 */
export function creatorSelfLabels(videoEvent) {
  const labels = new Set();
  for (const tag of videoEvent?.tags ?? []) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    let value = null;
    if (tag[0] === 'l' && tag[2] === NAMESPACE) value = tag[1];
    if (tag[0] === 'content-warning') value = tag[1];
    const normalized = normalizeLabel(value);
    if (normalized !== null) labels.add(normalized);
  }
  return labels;
}

/**
 * Crossings that warrant a strike: the community had to apply a label the
 * creator did not self-apply. Returns [{ label }].
 */
export function strikesFor(crossings, selfLabels) {
  return crossings
    .filter(({ label }) => !selfLabels.has(label))
    .map(({ label }) => ({ label }));
}
