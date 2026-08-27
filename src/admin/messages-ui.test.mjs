// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from 'vitest';
import messagesHTML from './messages.html';

// Pull one top-level `function name(...) { ... }` out of the bundled HTML and
// eval it, so we test the ACTUAL shipped source (no logic duplication) rather
// than only asserting its text is present. Brace-matching is safe here because
// the extracted functions keep their braces balanced (regex literals like
// {2,} balance internally). Used for the pure helpers that carry real logic.
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found: ' + name);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { i++; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function('return (' + src.slice(start, i) + ')')();
}

describe('messages UI — new message compose hooks', () => {
  it('has a New Message button and recipient bar', () => {
    expect(messagesHTML).toContain('New Message');
    expect(messagesHTML).toContain('openNewMessage');
    expect(messagesHTML).toContain('recipient-input');
    expect(messagesHTML).toContain('resolveRecipient');
  });

  it('calls the recipient resolve endpoint', () => {
    expect(messagesHTML).toContain('/admin/api/recipient/resolve?input=');
  });

  it('has a template picker wired to the templates endpoint', () => {
    expect(messagesHTML).toContain('template-select');
    expect(messagesHTML).toContain('/admin/api/dm-templates');
    expect(messagesHTML).toContain('loadTemplates');
  });

  it('uses the friendlier empty-thread copy', () => {
    expect(messagesHTML).toContain('No messages yet');
  });
});

describe('messages UI — progressive render + optimistic send', () => {
  it('renders the conversation list before profiles resolve (background patch)', () => {
    // #152: paint immediately, then fetch profiles and re-render.
    expect(messagesHTML).toContain('fetchProfiles(pubkeys).then(() => renderConversations())');
    expect(messagesHTML).toContain("filterConversations(currentConversationSearch())");
  });

  it('appends an optimistic pending bubble and reverts on failure', () => {
    // #151: optimistic append + clear composer immediately, revert on error.
    expect(messagesHTML).toContain('function createMessageBubble(');
    expect(messagesHTML).toContain('function appendOutgoingBubble(');
    expect(messagesHTML).toContain('appendOutgoingBubble(text, sha256, { pending: true })');
    expect(messagesHTML).toContain('pending-tag');
    // Revert path restores the typed text.
    expect(messagesHTML).toContain('pendingBubble.remove();');
    expect(messagesHTML).toContain('input.value = text;');
  });

  it('guards the optimistic send against mid-send navigation / thread switch', () => {
    // Snapshot the target thread (don't POST to whatever is selected when the
    // fetch line runs) and only touch the bubble if it's still in the DOM.
    expect(messagesHTML).toContain('const targetPubkey = selectedPubkey;');
    expect(messagesHTML).toContain("encodeURIComponent(targetPubkey)");
    expect(messagesHTML).toContain('pendingBubble.isConnected');
    expect(messagesHTML).toContain('selectedPubkey === targetPubkey');
    // Failed first message of an empty thread restores the empty-state placeholder.
    expect(messagesHTML).toContain('renderThread([])');
  });
});

describe('messages UI — conversation list pagination', () => {
  it('does not cap the list at a single hardcoded page', () => {
    // The bug: the sidebar fetched exactly one page and never asked for more,
    // so history only reached back as far as the 50 most-recent conversations.
    expect(messagesHTML).not.toContain("'/admin/api/messages?limit=50'");
  });

  it('fetches conversations with an offset so it can page through history', () => {
    expect(messagesHTML).toContain('conversationsOffset');
    expect(messagesHTML).toContain('&offset=');
  });

  it('tracks whether more pages remain, keyed off a full page coming back', () => {
    // hasMore stays true only while the server returns a complete page.
    expect(messagesHTML).toContain('conversationsHasMore');
    expect(messagesHTML).toContain('CONVERSATIONS_PAGE_SIZE');
    expect(messagesHTML).toContain('page.length === CONVERSATIONS_PAGE_SIZE');
  });

  it('appends further pages, de-duped, instead of replacing the loaded list', () => {
    expect(messagesHTML).toContain('dedupeConversations(conversations.concat(page))');
  });

  it('discards a stale in-flight append when a fresh load supersedes it', () => {
    // Guards the Refresh-overlaps-append race that would otherwise desync
    // conversationsOffset and skip a page.
    expect(messagesHTML).toContain('conversationsGen');
    expect(messagesHTML).toContain('if (gen !== conversationsGen) return;');
  });

  it('loads the next page when scrolled within 200px of the bottom', () => {
    expect(messagesHTML).toContain('function loadMoreConversations');
    expect(messagesHTML).toContain("getElementById('conversation-items').addEventListener('scroll'");
    expect(messagesHTML).toContain('scrollHeight - 200');
  });

  it('guards load-more against overlap, past the last page, and a pending error', () => {
    expect(messagesHTML).toContain('conversationsLoading');
    // No further fetch once no full page remains, a load is already in flight, or
    // a page failed (so scroll/auto-fill can't silently re-attempt it).
    expect(messagesHTML).toContain('if (conversationsLoading || !conversationsHasMore || conversationsError)');
  });

  it('auto-fills the next page when a short page leaves no scrollbar', () => {
    // Without a scrollbar the scroll listener never fires, so history would be
    // unreachable on a tall viewport; keep paging until it fills or runs out.
    expect(messagesHTML).toContain('function maybeAutoFillConversations');
    expect(messagesHTML).toContain('c.scrollHeight <= c.clientHeight');
  });

  it('preserves scroll across re-render on append but not while filtering', () => {
    expect(messagesHTML).toContain('const prevScroll = container.scrollTop;');
    expect(messagesHTML).toContain('const preserveScroll = !currentConversationSearch().trim();');
    expect(messagesHTML).toContain('if (preserveScroll) container.scrollTop = prevScroll;');
  });
});

describe('messages UI — output escaping (XSS)', () => {
  it('escapeHtml also escapes quotes so attribute interpolation cannot break out', () => {
    // profile.picture is attacker-controlled (any pubkey publishes its own
    // kind-0) and is interpolated into <img src="...">, a double-quoted attr.
    // escapeHtml uses document.createElement, so it can't be eval-run in the
    // no-DOM workers env; assert the quote-escaping is wired instead.
    const fn = messagesHTML.slice(
      messagesHTML.indexOf('function escapeHtml'),
      messagesHTML.indexOf('function escapeHtml') + 800,
    );
    expect(fn).toContain(".replace(/\"/g, '&quot;')");
    expect(fn).toContain(".replace(/'/g, '&#39;')");
  });

  it('wraps the attacker-controlled profile.picture in escapeHtml at every img-src sink', () => {
    // The escapeHtml fix is only useful if the sinks actually call it. Both the
    // avatar row and the thread header build <img src> from profile.picture.
    const sinks = messagesHTML.match(/src="\$\{escapeHtml\(profile\.picture\)\}"/g) || [];
    expect(sinks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('messages UI — identifier search (full-history reach)', () => {
  it('runs an identifier lookup when the search box is submitted with Enter', () => {
    expect(messagesHTML).toContain("getElementById('search-input').addEventListener('keydown'");
    expect(messagesHTML).toContain("event.key === 'Enter'");
    expect(messagesHTML).toContain('searchByIdentifier(');
  });

  it('resolves the typed identifier via the recipient endpoint from within searchByIdentifier', () => {
    // Pin the fetch to the search function specifically — the same endpoint
    // literal also appears in the pre-existing compose flow, so asserting the
    // bare string would pass even if searchByIdentifier's fetch were deleted.
    const fn = messagesHTML.slice(
      messagesHTML.indexOf('async function searchByIdentifier'),
      messagesHTML.indexOf('function currentConversationSearch'),
    );
    expect(fn).toContain("fetch('/admin/api/recipient/resolve?input=' + encodeURIComponent(query))");
    expect(fn).toContain('selectConversation(data.pubkey, { searchGen: gen })');
  });

  it('advertises identifier input in the search placeholder', () => {
    expect(messagesHTML).toContain('placeholder="Search name, pubkey, npub, or nip-05');
  });

  it('reports name-search scope, no-match, and failure to the moderator', () => {
    expect(messagesHTML).toContain('covers loaded conversations');
    expect(messagesHTML).toContain('No match for that pubkey, npub, or nip-05.');
    expect(messagesHTML).toContain('Search failed. Try again.');
  });

  it('does not open a thread when the resolver returns no pubkey', () => {
    expect(messagesHTML).toContain('if (!data.pubkey)');
  });

  it('clears the search box BEFORE opening so the list does not flash empty', () => {
    // Clearing must precede selectConversation (which re-renders the list); doing
    // it after would render the empty filtered view first, then repopulate.
    expect(messagesHTML).toMatch(
      /getElementById\('search-input'\)\.value = '';[\s\S]*?selectConversation\(data\.pubkey, \{ searchGen: gen \}\)/,
    );
  });

  it('keeps search progress visible until profile warm-up finishes', () => {
    const fn = messagesHTML.slice(
      messagesHTML.indexOf('async function searchByIdentifier'),
      messagesHTML.indexOf('function currentConversationSearch'),
    );
    expect(fn).toMatch(
      /await fetchProfiles\(\[data\.pubkey\]\)[\s\S]*?setStatus\(''\);[\s\S]*?selectConversation/,
    );
  });

  it('clears a lingering search status while the moderator keeps typing', () => {
    expect(messagesHTML).toContain('function onSearchInput');
    expect(messagesHTML).toContain('oninput="onSearchInput(this.value)"');
  });

  it('discards stale identifier results after a newer search or navigation', () => {
    const searchFn = messagesHTML.slice(
      messagesHTML.indexOf('async function searchByIdentifier'),
      messagesHTML.indexOf('function currentConversationSearch'),
    );
    const selectFn = messagesHTML.slice(
      messagesHTML.indexOf('async function selectConversation'),
      messagesHTML.indexOf('async function loadThread'),
    );
    expect(searchFn).toContain('const gen = ++conversationSearchGen;');
    expect(searchFn).toContain('if (gen !== conversationSearchGen) return;');
    expect(searchFn).toContain('selectConversation(data.pubkey, { searchGen: gen })');
    expect(messagesHTML).toMatch(/function onSearchInput\(value\) \{\s*conversationSearchGen\+\+;/);
    expect(selectFn).toContain('conversationSearchGen++');
    expect(selectFn).toMatch(
      /conversationSearchGen\+\+;\s*const searchStatus = document\.getElementById\('search-status'\);\s*if \(searchStatus\) searchStatus\.textContent = '';/,
    );
  });
});

describe('messages UI — pure logic (behavioral, eval-extracted from shipped source)', () => {
  it('looksLikeIdentifier accepts identifier shapes and rejects plain names', () => {
    const looksLikeIdentifier = extractFunction(messagesHTML, 'looksLikeIdentifier');
    // Identifier shapes -> lookup
    expect(looksLikeIdentifier('a'.repeat(64))).toBe(true);      // hex pubkey
    expect(looksLikeIdentifier('A'.repeat(64))).toBe(true);      // hex, case-insensitive
    expect(looksLikeIdentifier('npub1abcdef023')).toBe(true);    // npub
    expect(looksLikeIdentifier('mjb@divine.video')).toBe(true);  // user@domain
    expect(looksLikeIdentifier('@mjb')).toBe(true);              // @handle
    expect(looksLikeIdentifier('mjb.divine.video')).toBe(true);  // bare host.tld
    // Plain text -> stays the live name filter
    expect(looksLikeIdentifier('alice')).toBe(false);
    expect(looksLikeIdentifier('Bob Smith')).toBe(false);
    expect(looksLikeIdentifier('a'.repeat(63))).toBe(false);     // too-short hex fragment
    // Documents the deliberately-accepted edge: a dotted name resolves as a host.
    // If someone later "tightens" the guard, this is the boundary to reconsider.
    expect(looksLikeIdentifier('yo.lo')).toBe(true);
  });

  it('dedupeConversations drops repeats by conversation id, keeping first seen', () => {
    const dedupeConversations = extractFunction(messagesHTML, 'dedupeConversations');
    const rows = [
      { conversation_id: 'a', latest_message: 'first-a' },
      { conversation_id: 'b', latest_message: 'first-b' },
      { conversation_id: 'a', latest_message: 'dup-a' },       // boundary re-surface
      { participant_pubkey: 'pk1', latest_message: 'by-pubkey' },
      { participant_pubkey: 'pk1', latest_message: 'dup-pubkey' },
      { latest_message: 'keyless' },                           // no key -> kept (parity)
    ];
    const out = dedupeConversations(rows);
    expect(out.map((r) => r.latest_message)).toEqual(['first-a', 'first-b', 'by-pubkey', 'keyless']);
  });
});

describe('messages UI — failed load-more recovery (#207)', () => {
  it('surfaces a failed append instead of stopping silently like end-of-history', () => {
    // The append branch of the catch must flag the error and re-render, not
    // leave a short list that reads as "no older conversations".
    expect(messagesHTML).toContain('else if (append && gen === conversationsGen)');
    expect(messagesHTML).toContain('conversationsError = true;');
  });

  it('renders a clickable, announced retry row only when not filtering', () => {
    // The retry row is gated on a pending error and an inactive filter, and is
    // announced to assistive tech.
    expect(messagesHTML).toContain('if (!conversationsError || currentConversationSearch().trim()) return;');
    expect(messagesHTML).toContain('class="load-more-error" role="status"');
    expect(messagesHTML).toContain("Couldn't load more");
    expect(messagesHTML).toContain('onclick="retryLoadMore()"');
  });

  it('keeps the retry row reachable even if the unfiltered list is empty', () => {
    // Defends the #207 invariant: an append error must never hide behind the
    // empty-list branch, so both render paths append the retry row.
    const matches = messagesHTML.match(/appendLoadMoreError\(container\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('retry clears the error, re-renders for feedback, and re-requests the same page', () => {
    // offset is not advanced on failure, so loadMoreConversations re-requests it.
    expect(messagesHTML).toContain('function retryLoadMore');
    expect(messagesHTML).toMatch(
      /function retryLoadMore[\s\S]*?conversationsError = false;[\s\S]*?renderConversations\(\);[\s\S]*?loadMoreConversations\(\)/,
    );
  });

  it('reveals the retry row by scrolling to the bottom on failure', () => {
    expect(messagesHTML).toContain('if (container) container.scrollTop = container.scrollHeight;');
  });

  it('clears the error flag on a fresh load AND on a successful page (each pinned)', () => {
    // Not a tautology: pin each clear to its own branch so deleting either one
    // fails this test even though the literal appears elsewhere.
    expect(messagesHTML).toMatch(/conversationsHasMore = true;\s*\n\s*conversationsError = false;/);
    expect(messagesHTML).toMatch(/conversationsOffset \+= page\.length;\s*\n\s*conversationsError = false;/);
  });
});
