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
  const isAsync = src.slice(Math.max(0, start - 6), start) === 'async ';
  // eslint-disable-next-line no-new-func
  return new Function('return (' + (isAsync ? 'async ' : '') + src.slice(start, i) + ')')();
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

// divine-mobile#7340: a reporter can include the direct message they are
// reporting. The reader stores it as dm_log.unverified_excerpt, apart from the
// reporter's note; the UI must say where it came from and that it is unverified.
describe('messages UI — reporter-included message', () => {
  it('renders the excerpt under its provenance, routed through escapeHtml', () => {
    // escapeHtml needs a DOM, so stand in a marker that proves the excerpt
    // went through it rather than straight into innerHTML.
    globalThis.escapeHtml = (s) => `[escaped:${s}]`;
    try {
      const unverifiedExcerptHtml = extractFunction(messagesHTML, 'unverifiedExcerptHtml');
      const html = unverifiedExcerptHtml('<img src=x onerror=alert(1)>');

      expect(html).toContain('[escaped:<img src=x onerror=alert(1)>]');
      expect(html.replace('[escaped:<img src=x onerror=alert(1)>]', '')).not.toContain('<img');
      expect(html).toContain('Unverified message excerpt');
      expect(html).toContain('Provided by the reporter');
      // Who sent the message is the reporter's claim as much as its text, and
      // the sender and message ID lines in their note carry no label of their
      // own, so the note has to cover them too.
      expect(html).toContain('like the sender and message ID in their note');
      expect(html).toContain('not proof of what was sent or who sent it');
      // The sender does sign the NIP-17 seal, but the reporter doesn't forward
      // it: what reaches us is the unsigned message and the reporter's word.
      expect(html).toContain('Nothing in this report is signed by the sender');
      expect(html).not.toContain('are not signed');
    } finally {
      delete globalThis.escapeHtml;
    }
  });

  // Runs the shipped createMessageBubble with the page helpers it calls
  // stood in, so the excerpt branch is exercised for every shape a row can
  // take: a value, null (a row from before this change, once the column
  // exists), missing (a table the column has not been added to yet), or empty.
  it('adds the excerpt block to a message bubble only when the row has one', () => {
    const stubs = {
      document: { createElement: () => ({ className: '', innerHTML: '' }) },
      escapeHtml: (s) => String(s ?? ''),
      relativeTime: () => 'just now',
      badgeLabel: (t) => t,
    };
    try {
      Object.assign(globalThis, stubs);
      globalThis.unverifiedExcerptHtml = extractFunction(messagesHTML, 'unverifiedExcerptHtml');
      const createMessageBubble = extractFunction(messagesHTML, 'createMessageBubble');
      const bubble = (extra) => createMessageBubble({
        direction: 'incoming',
        content: 'DM Message Report',
        message_type: 'conversation_report',
        created_at: '2026-11-04 12:00:00',
        ...extra,
      }).innerHTML;

      expect(bubble({ unverified_excerpt: 'you will regret this' })).toContain('unverified-excerpt');
      expect(bubble({ unverified_excerpt: 'you will regret this' })).toContain('you will regret this');
      expect(bubble({ unverified_excerpt: null })).not.toContain('unverified-excerpt');
      expect(bubble({})).not.toContain('unverified-excerpt');
      expect(bubble({ unverified_excerpt: '' })).not.toContain('unverified-excerpt');
    } finally {
      for (const key of [...Object.keys(stubs), 'unverifiedExcerptHtml']) delete globalThis[key];
    }
  });

  it('keeps the excerpt\'s own line breaks', () => {
    expect(messagesHTML).toMatch(/\.unverified-excerpt-text\s*\{[^}]*white-space:\s*pre-wrap/);
  });
});

// Slice a function's source (sync or async) up to its closing brace at the
// page's 4-space indent.
function sliceFn(prefix) {
  const start = messagesHTML.indexOf(prefix);
  if (start === -1) throw new Error('function not found: ' + prefix);
  return messagesHTML.slice(start, messagesHTML.indexOf('\n    }\n', start) + 6);
}

describe('messages UI — filter chips and No reply needed', () => {
  it('FILTER_CHIPS lists the seven chips in order with these labels', () => {
    const m = messagesHTML.match(/const FILTER_CHIPS = \[([\s\S]*?)\n    \];/);
    expect(m).not.toBeNull();
    const chips = [...m[1].matchAll(/key: '([a-z]*)', label: '([^']*)'/g)].map(x => [x[1], x[2]]);
    expect(chips).toEqual([
      ['', 'All'],
      ['waiting', 'Waiting on us'],
      ['person', 'A person wrote'],
      ['reports', 'Reports'],
      ['notices', 'Notices'],
      ['outcomes', 'Outcomes'],
      ['warnings', 'Warnings'],
    ]);
  });

  it('chip tooltips carry the agreed copy', () => {
    for (const copy of [
      "Someone typed to us in the last 30 days and nobody on the team has replied since. Our automatic messages don't count as a reply. Messages from before 13 August aren't counted.",
      'Everyone who has typed to us since 13 August, answered or not. For the ones that need a reply, use Waiting on us.',
      'Has at least one automatic report from the app.',
      'Has at least one moderation notice we sent.',
      'Has at least one report outcome we sent.',
      'Has at least one community warning we sent.',
    ]) {
      expect(messagesHTML).toContain(copy);
    }
  });

  it('fetchConversations sends the active filter, and nothing for All', () => {
    expect(messagesHTML).toContain("'&filter=' + encodeURIComponent(activeFilter)");
    expect(messagesHTML).toMatch(/activeFilter \? '&filter=' \+ encodeURIComponent\(activeFilter\) : ''/);
  });

  it('setFilter starts a fresh load and ignores re-selecting the active chip', () => {
    const fn = sliceFn('function setFilter(');
    expect(fn).toMatch(/if \(key === activeFilter\) return;/);
    expect(fn).toContain('fetchConversations()');
    expect(fn).not.toContain('append');
    expect(fn).toContain('maybeAutoFillConversations()');
  });

  it('restoreFilter falls back to All for an unknown key or a throwing store', () => {
    const FILTER_CHIPS = [{ key: '' }, { key: 'waiting' }, { key: 'person' }];
    const text = sliceFn('function restoreFilter(');
    const make = (ls) => new Function('FILTER_CHIPS', 'FILTER_STORAGE_KEY', 'localStorage', 'return (' + text + ')')(FILTER_CHIPS, 'k', ls);
    expect(make({ getItem: () => 'bogus' })()).toBe('');
    expect(make({ getItem: () => { throw new Error('blocked'); } })()).toBe('');
    expect(make({ getItem: () => 'waiting' })()).toBe('waiting');
    expect(make({ getItem: () => null })()).toBe('');
  });

  it('reply-state handlers drop stale responses', () => {
    for (const name of ['loadReplyState', 'markNoReplyNeeded', 'undoNoReplyNeeded']) {
      const fn = sliceFn('async function ' + name + '(');
      expect(fn, name).toMatch(/selectedPubkey !== (pubkey|target)/);
    }
  });

  it('counts refresh after refresh, send and no-reply changes', () => {
    for (const name of ['refreshAll', 'sendMessage', 'markNoReplyNeeded', 'undoNoReplyNeeded']) {
      expect(sliceFn('async function ' + name + '('), name).toContain('fetchFilterCounts()');
    }
  });

  it('the thread header has the No reply needed button and undo copy', () => {
    expect(messagesHTML).toContain('id="no-reply-btn"');
    expect(messagesHTML).toContain('No reply needed');
    expect(messagesHTML).toContain('Marked no reply needed');
    expect(messagesHTML).toContain('Undo');
    expect(messagesHTML).toContain('No conversations match this filter.');
  });

  it('init restores the saved filter before the first load', () => {
    const init = messagesHTML.slice(messagesHTML.indexOf('async function init()'));
    expect(init.indexOf('restoreFilter()')).toBeGreaterThan(-1);
    expect(init.indexOf('restoreFilter()')).toBeLessThan(init.indexOf('fetchConversations()'));
    expect(init).toContain('fetchFilterCounts()');
  });
});

describe('messages UI — reply state behavior', () => {
  const saved = {};
  function setup({ selected, marked, state }) {
    const calls = [];
    for (const k of ['selectedPubkey', 'markedPubkey', 'showReplyState', 'fetch']) saved[k] = globalThis[k];
    globalThis.selectedPubkey = selected;
    globalThis.markedPubkey = marked;
    globalThis.showReplyState = (arg) => calls.push(arg);
    globalThis.fetch = async () => ({ ok: true, json: async () => state });
    return { calls, loadReplyState: extractFunction(messagesHTML, 'loadReplyState') };
  }
  function restore() {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k];
    }
  }

  it('does not touch the header when another conversation is open', async () => {
    const { calls, loadReplyState } = setup({ selected: 'B', marked: null, state: { waiting: true } });
    try {
      await loadReplyState('A');
      expect(calls).toEqual([]);
    } finally { restore(); }
  });

  it('keeps Undo visible on reload while the mark is active', async () => {
    const { calls, loadReplyState } = setup({
      selected: 'A', marked: 'A', state: { waiting: false, no_reply_needed_at: '2026-11-16T00:00:00Z' },
    });
    try {
      await loadReplyState('A');
      expect(calls.at(-1)).toEqual({ waiting: false, marked: true });
    } finally { restore(); }
  });

  it('does not show Undo for a mark made on a different conversation', async () => {
    const { calls, loadReplyState } = setup({
      selected: 'A', marked: 'B', state: { waiting: false, no_reply_needed_at: '2026-11-16T00:00:00Z' },
    });
    try {
      await loadReplyState('A');
      expect(calls.at(-1)).toEqual({ waiting: false, marked: false });
    } finally { restore(); }
  });
});

describe('messages UI — handled rows and people-chip previews', () => {
  const names = ['activeFilter', 'selectedPubkey', 'markedPubkey', 'conversations', 'showReplyState', 'renderConversations',
    'fetchFilterCounts', 'fetch', 'alert', 'document', 'currentConversationSearch', 'avatarHtml', 'displayName',
    'relativeTime', 'badgeClass', 'badgeLabel', 'escapeHtml', 'appendLoadMoreError', 'setConversationWaiting',
    'renderConversationList', 'loadReplyState'];
  const saved = {};
  function setup({ filter = '', rows = [], selected = 'A' } = {}) {
    for (const k of names) saved[k] = globalThis[k];
    const g = globalThis;
    g.activeFilter = filter;
    g.selectedPubkey = selected;
    g.markedPubkey = null;
    g.conversations = rows;
    g.showReplyState = () => {};
    g.fetchFilterCounts = () => {};
    g.alert = () => {};
    g.currentConversationSearch = () => '';
    g.avatarHtml = () => '';
    g.displayName = (p) => p;
    g.relativeTime = (t) => 'T:' + t;
    g.badgeClass = () => 'b';
    g.badgeLabel = (t) => (t === 'creator_reply' ? 'Creator Reply' : t);
    g.escapeHtml = (t) => String(t);
    g.appendLoadMoreError = () => {};
    const container = { innerHTML: '', scrollTop: 0 };
    g.document = { getElementById: () => container };
    g.setConversationWaiting = extractFunction(messagesHTML, 'setConversationWaiting');
    g.renderConversationList = extractFunction(messagesHTML, 'renderConversationList');
    g.renderConversations = () => g.renderConversationList(g.conversations);
    g.loadReplyState = extractFunction(messagesHTML, 'loadReplyState');
    const respond = (state) => { g.fetch = async () => ({ ok: true, json: async () => state }); };
    respond({ waiting: false });
    return {
      respond,
      render: () => { g.renderConversationList(g.conversations); return container.innerHTML; },
      markNoReplyNeeded: extractFunction(messagesHTML, 'markNoReplyNeeded'),
      undoNoReplyNeeded: extractFunction(messagesHTML, 'undoNoReplyNeeded'),
    };
  }
  function restore() {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k];
    }
  }
  const row = (over = {}) => ({
    participant_pubkey: 'A', latest_message: 'Your video was removed', message_type: 'moderation_notice',
    last_message_at: 'LAST', last_typed_message: 'That was a news clip', last_typed_at: 'TYPED', waiting: true, ...over,
  });

  it("people chips preview the person's latest typed message", () => {
    for (const filter of ['waiting', 'person']) {
      const { render } = setup({ filter, rows: [row()] });
      try {
        const html = render();
        expect(html, filter).toContain('That was a news clip');
        expect(html, filter).toContain('Creator Reply');
        expect(html, filter).toContain('T:TYPED');
        expect(html, filter).not.toContain('Your video was removed');
      } finally { restore(); }
    }
  });

  it('other chips keep the last message', () => {
    for (const filter of ['', 'notices']) {
      const { render } = setup({ filter, rows: [row()] });
      try {
        const html = render();
        expect(html, filter).toContain('Your video was removed');
        expect(html, filter).toContain('T:LAST');
        expect(html, filter).not.toContain('That was a news clip');
      } finally { restore(); }
    }
  });

  it('falls back to the last message when last_typed_message is null', () => {
    const { render } = setup({ filter: 'person', rows: [row({ last_typed_message: null, last_typed_at: null })] });
    try {
      const html = render();
      expect(html).toContain('Your video was removed');
      expect(html).toContain('T:LAST');
    } finally { restore(); }
  });

  it('a row greys on Waiting on us only when it is no longer waiting', () => {
    const cases = [['waiting', false, true], ['waiting', true, false], ['', false, false], ['person', false, false]];
    for (const [filter, waiting, greyed] of cases) {
      const { render } = setup({ filter, rows: [row({ waiting })] });
      try {
        expect(render().includes('handled'), `${filter}/${waiting}`).toBe(greyed);
      } finally { restore(); }
    }
  });

  it('mark, undo and a later waiting state flip the grey', async () => {
    const { render, respond, markNoReplyNeeded, undoNoReplyNeeded } = setup({ filter: 'waiting', rows: [row()] });
    try {
      await markNoReplyNeeded();
      expect(render()).toContain('handled');

      respond({ waiting: true });
      await undoNoReplyNeeded();
      expect(render()).not.toContain('handled');

      respond({ waiting: false });
      await globalThis.loadReplyState('A');
      expect(render()).toContain('handled');

      respond({ waiting: true });
      await globalThis.loadReplyState('A');
      expect(render()).not.toContain('handled');
    } finally { restore(); }
  });

  it('a stale reply-state response does not touch the row', async () => {
    const { render } = setup({ filter: 'waiting', rows: [row()], selected: 'B' });
    try {
      await globalThis.loadReplyState('A');
      expect(render()).not.toContain('handled');
    } finally { restore(); }
  });

  // fetch stub keyed by method: `onPost` / `onDelete` / `onGet` run before the response.
  function routedFetch({ onPost, onDelete, onGet, state }) {
    globalThis.fetch = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      if (method === 'POST') onPost?.();
      else if (method === 'DELETE') onDelete?.();
      else onGet?.();
      return { ok: true, json: async () => (method === 'GET' ? state : {}) };
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('a reply greys the row even when the moderator opens another conversation mid-send', async () => {
    const { render } = setup({ filter: 'waiting', rows: [row()] });
    const extra = ['compose-input', 'compose-sha256', 'send-btn'];
    for (const k of ['appendOutgoingBubble', 'relativeTime']) saved[k] = globalThis[k];
    for (const k of ['refreshRowWaiting']) saved[k] = globalThis[k];
    try {
      const listDocument = globalThis.document;
      const el = { value: ' hello ', disabled: false, focus() {}, innerHTML: '', scrollTop: 0 };
      globalThis.document = { getElementById: (id) => (extra.includes(id) ? el : { innerHTML: '', scrollTop: 0 }) };
      globalThis.appendOutgoingBubble = () => ({ isConnected: false });
      try { globalThis.refreshRowWaiting = extractFunction(messagesHTML, 'refreshRowWaiting'); } catch (e) { /* not extracted yet */ }
      routedFetch({ onPost: () => { globalThis.selectedPubkey = 'B'; }, state: { waiting: false } });
      await extractFunction(messagesHTML, 'sendMessage')();
      await flush();
      globalThis.document = listDocument;
      expect(render()).toContain('handled');
    } finally { restore(); }
  });

  it('undo with the thread moved on after the DELETE un-greys the row', async () => {
    const { render, undoNoReplyNeeded } = setup({ filter: 'waiting', rows: [row({ waiting: false })] });
    saved.refreshRowWaiting = globalThis.refreshRowWaiting;
    try {
      try { globalThis.refreshRowWaiting = extractFunction(messagesHTML, 'refreshRowWaiting'); } catch (e) { /* not extracted yet */ }
      routedFetch({ onDelete: () => { globalThis.selectedPubkey = 'B'; }, state: { waiting: true } });
      await undoNoReplyNeeded();
      await flush();
      expect(render()).not.toContain('handled');
    } finally { restore(); }
  });

  it('undo with the thread open, moved on during the state fetch, still un-greys the row', async () => {
    const { render, undoNoReplyNeeded } = setup({ filter: 'waiting', rows: [row({ waiting: false })] });
    try {
      routedFetch({ onGet: () => { globalThis.selectedPubkey = 'B'; }, state: { waiting: true } });
      await undoNoReplyNeeded();
      await flush();
      expect(render()).not.toContain('handled');
    } finally { restore(); }
  });
});
