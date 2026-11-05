// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Parses a message a reporter chose to include in a moderation DM
// ABOUTME: The excerpt is unverified: it is what the reporter's app showed

// When someone reports a direct message, divine-mobile lets them include that
// message. It travels only inside the NIP-17 moderation DM: the body ends with
// this heading followed by the message, and the rumor carries the tag below.
// Both strings are divine-mobile's ContentReportingService.unverifiedExcerpt*
// constants, and dm-report-contract.test.mjs pins them end to end.
//
// "Unverified" is the whole point. A NIP-17 rumor is unsigned, so the text is
// whatever the reporter's device decrypted, not proof of what was sent. It is
// for a human to weigh, never an input to automated enforcement -- which is
// why processRumor keeps it out of the report record entirely.
export const UNVERIFIED_EXCERPT_HEADING = 'Unverified message excerpt provided by the reporter:';
const UNVERIFIED_EXCERPT_TAG = Object.freeze(['evidence', 'unverified_excerpt']);

const SEPARATOR = `\n\n${UNVERIFIED_EXCERPT_HEADING}\n`;

/**
 * Whether a rumor's tags mark it as carrying a reporter-included message.
 * @param {unknown} tags - rumor.tags
 * @returns {boolean}
 */
export function hasUnverifiedExcerptTag(tags) {
  return Array.isArray(tags) && tags.some(
    (tag) => Array.isArray(tag)
      && tag[0] === UNVERIFIED_EXCERPT_TAG[0]
      && tag[1] === UNVERIFIED_EXCERPT_TAG[1],
  );
}

/**
 * Split a moderation DM body into the reporter's note and the message they
 * included.
 *
 * Splits at the first heading. Everything after it is shown as provided by the
 * reporter, which is true of every byte of the DM; splitting at the last one
 * instead would let a reported message that quotes the heading put part of
 * someone else's words under the reporter's own note.
 *
 * The excerpt comes back exactly as sent, whitespace included. Only the
 * caller's tag check decides whether a body is parsed at all: the heading alone
 * is just text anyone can type.
 *
 * @param {unknown} content - rumor.content
 * @returns {{note: string, excerpt: string} | null} null when there is no
 *   heading or nothing after it, so the caller keeps the DM whole
 */
export function splitUnverifiedExcerpt(content) {
  if (typeof content !== 'string') return null;
  const at = content.indexOf(SEPARATOR);
  if (at === -1) return null;
  const excerpt = content.slice(at + SEPARATOR.length);
  if (!excerpt.trim()) return null;
  return { note: content.slice(0, at), excerpt };
}
