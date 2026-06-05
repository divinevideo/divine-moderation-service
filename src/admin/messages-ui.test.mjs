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
  });
});
