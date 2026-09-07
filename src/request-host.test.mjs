// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests the shared local-request hostname guard
// ABOUTME: Keeps development authentication bypasses off deployed hostnames

import { describe, expect, it } from 'vitest';
import { isLocalHostname, isLocalRequest } from './request-host.mjs';

describe('local request detection', () => {
  it.each(['localhost', '127.0.0.1', '[::1]', 'worker.localhost'])(
    'accepts %s as local',
    (hostname) => expect(isLocalHostname(hostname)).toBe(true)
  );

  it('rejects deployed hostnames', () => {
    expect(isLocalHostname('moderation.admin.divine.video')).toBe(false);
    expect(isLocalRequest(new Request('https://moderation-api.divine.video/api/v1/status'))).toBe(false);
  });
});
