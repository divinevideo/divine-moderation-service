// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from 'vitest';
import messagesHTML from './messages.html';

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

  it('appends further pages instead of replacing the loaded list', () => {
    expect(messagesHTML).toContain('conversations.concat(page)');
  });

  it('loads the next page when the conversation list is scrolled near the bottom', () => {
    expect(messagesHTML).toContain('function loadMoreConversations');
    expect(messagesHTML).toContain("getElementById('conversation-items').addEventListener('scroll'");
  });

  it('guards load-more against overlap and past the last page', () => {
    expect(messagesHTML).toContain('conversationsLoading');
    // No further fetch once no full page remains or a load is already in flight.
    expect(messagesHTML).toContain('if (conversationsLoading || !conversationsHasMore)');
  });

  it('preserves scroll position across re-render so appends do not jump to top', () => {
    expect(messagesHTML).toContain('const prevScroll = container.scrollTop;');
    expect(messagesHTML).toContain('container.scrollTop = prevScroll;');
  });
});
