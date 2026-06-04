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
