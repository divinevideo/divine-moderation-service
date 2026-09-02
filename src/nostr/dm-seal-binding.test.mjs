// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Security regression suite for the NIP-17 seal<->rumor author binding
// ABOUTME: A rumor is unsigned, so its pubkey is only a claim until the seal confirms it
//
// NIP-17 ("Encrypting"): "Clients MUST verify if pubkey of the `kind:13` is
// the same pubkey on the `kind:14`, otherwise any sender can impersonate
// others by simply changing the pubkey on `kind:14`."
//
// These tests drive the real syncInbox path -- real NIP-44 crypto, real
// schnorr signing, real D1 -- over a stubbed relay socket, so they assert on
// what lands in dm_log and user_reports rather than on a helper's return
// value. Everything downstream of ingest keys on dm_log.sender_pubkey: the
// admin Messages UI derives the reply target from it, direction is decided by
// comparing it to the moderator pubkey, and user_reports.reporter_pubkey is
// copied from it and later drives the report-outcome DM fanout.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { generateSecretKey, getPublicKey, finalizeEvent, getEventHash } from 'nostr-tools/pure';
// nip59's wrapEvent takes the rumor template directly; nip17's same-named
// export is the higher-level (sk, recipient, message) helper.
import { wrapEvent } from 'nostr-tools/nip59';
import { bytesToHex } from '@noble/hashes/utils';
import * as nip44 from 'nostr-tools/nip44';
import { syncInbox } from './dm-reader.mjs';
import { initDmLogTable } from './dm-store.mjs';
import { initReportsTable } from '../reports.mjs';

const SHA256 = 'b'.repeat(64);

const conversationKey = (privateKey, publicKey) =>
  nip44.v2.utils.getConversationKey(privateKey, publicKey);

const encryptTo = (payload, privateKey, publicKey) =>
  nip44.v2.encrypt(JSON.stringify(payload), conversationKey(privateKey, publicKey));

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Build a gift wrap whose seal is signed by `sealSk` while the rumor inside
 * claims to be authored by `claimedPubkey`. When the two differ this is the
 * forgery NIP-17 requires clients to reject; when they match it is an
 * ordinary, well-formed NIP-17 DM.
 */
function buildGiftWrap({
  sealSk,
  claimedPubkey,
  recipientPubkey,
  tags,
  content,
  corruptSealSig = false,
  sealKind = 13,
}) {
  const rumor = {
    kind: 14,
    pubkey: claimedPubkey,
    created_at: nowSeconds(),
    tags,
    content,
  };
  rumor.id = getEventHash(rumor);

  const seal = finalizeEvent(
    {
      kind: sealKind,
      created_at: nowSeconds(),
      tags: [],
      content: encryptTo(rumor, sealSk, recipientPubkey),
    },
    sealSk,
  );
  if (corruptSealSig) {
    seal.sig = flipLastHexDigit(seal.sig);
  }

  const wrapSk = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      created_at: nowSeconds(),
      tags: [['p', recipientPubkey]],
      content: encryptTo(seal, wrapSk, recipientPubkey),
    },
    wrapSk,
  );
}

/** Smallest possible change that invalidates a signature. */
function flipLastHexDigit(hex) {
  const last = hex.slice(-1);
  return hex.slice(0, -1) + (last === '0' ? '1' : '0');
}

/**
 * Stand in for the relay: hand syncInbox exactly these gift wraps, then EOSE.
 * fetchGiftWraps only uses the constructor, addEventListener, send and close.
 */
function relayServing(giftWraps) {
  return class StubWebSocket {
    constructor() {
      this.listeners = {};
      // Emit 'open' on a microtask so fetchGiftWraps can register its listeners
      // first; the reply frames are then driven synchronously from send(), the
      // same shape report-poller.test.mjs and dm-reader.test.mjs use.
      queueMicrotask(() => this.emit('open', {}));
    }

    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    }

    emit(type, payload) {
      for (const handler of this.listeners[type] || []) handler(payload);
    }

    // The relay answers the client's REQ with the served gift wraps then EOSE,
    // echoing the subscription id from the REQ exactly as a real relay does (so
    // the frames carry the id fetchGiftWraps actually subscribed with). Any
    // later frame from the reader -- notably its polite CLOSE after EOSE -- is
    // not a REQ, so it draws no reply.
    send(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg[0] !== 'REQ') return;
      const subId = msg[1];
      for (const giftWrap of giftWraps) {
        this.emit('message', { data: JSON.stringify(['EVENT', subId, giftWrap]) });
      }
      this.emit('message', { data: JSON.stringify(['EOSE', subId]) });
    }

    // fetchGiftWraps calls close() after EOSE. A clean close fires no 'close'
    // event (matching dm-reader.test.mjs's mock), so it never re-enters the
    // reader's incomplete-read path -- the tests that need a mid-read drop
    // don't exist here; every case ends on EOSE or a per-event throw.
    close() {}
  };
}

/**
 * Run one sync against a stubbed relay.
 *
 * The stub is installed and removed inside this call rather than in an
 * afterEach hook: @cloudflare/vitest-pool-workers talks to the vitest host
 * over a WebSocket, so leaving a stubbed global installed when the test
 * function returns takes down the pool's own RPC channel (the run dies with
 * `Timeout calling "onTaskUpdate"` and reports no results at all).
 */
async function syncOverRelay(giftWraps, moderatorEnv) {
  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = relayServing(giftWraps);
  try {
    return await syncInbox(moderatorEnv);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
}

describe('NIP-17 seal<->rumor author binding (issue #215)', () => {
  const db = env.BLOSSOM_DB;
  let moderatorSk;
  let moderatorPubkey;
  let moderatorEnv;

  beforeEach(async () => {
    await db.prepare('DROP TABLE IF EXISTS dm_log').run();
    await db.prepare('DROP TABLE IF EXISTS user_reports').run();
    await db.prepare('DROP TABLE IF EXISTS moderation_results').run();
    await initDmLogTable(db);
    await initReportsTable(db);
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS moderation_results (
        sha256 TEXT PRIMARY KEY, action TEXT, provider TEXT, scores TEXT,
        categories TEXT, raw_response TEXT, moderated_at TEXT,
        reviewed_by TEXT, reviewed_at TEXT, review_notes TEXT, uploaded_by TEXT
      )`).run();

    moderatorSk = generateSecretKey();
    moderatorPubkey = getPublicKey(moderatorSk);
    moderatorEnv = {
      BLOSSOM_DB: db,
      NOSTR_PRIVATE_KEY: bytesToHex(moderatorSk),
      RELAY_POLLING_RELAY_URL: 'wss://relay.test.invalid',
    };
  });

  const dmRows = () => db.prepare('SELECT * FROM dm_log').all().then((r) => r.results);
  const reportRows = () => db.prepare('SELECT * FROM user_reports').all().then((r) => r.results);

  // The positive control. Without it, a fix that rejected every inbound DM
  // would satisfy every other test in this file and break the product.
  it('ingests a legitimate DM whose seal and rumor share an author', async () => {
    const senderSk = generateSecretKey();
    const senderPubkey = getPublicKey(senderSk);
    const result = await syncOverRelay([
      wrapEvent(
        {
          kind: 14,
          content: 'Please take another look at my appeal.',
          tags: [['p', moderatorPubkey]],
          created_at: nowSeconds(),
        },
        senderSk,
        moderatorPubkey,
      ),
    ], moderatorEnv);

    expect(result).toEqual({ synced: 1, skipped: 0, errors: 0 });
    const rows = await dmRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sender_pubkey).toBe(senderPubkey);
    expect(rows[0].recipient_pubkey).toBe(moderatorPubkey);
    expect(rows[0].direction).toBe('incoming');
    expect(rows[0].content).toBe('Please take another look at my appeal.');
  });

  // Variant A of the issue: the attacker signs the seal honestly with their
  // own key and names a third party on the rumor. Accepting this attributes
  // the message to the victim, and a moderator replying to that thread sends
  // their answer to the victim rather than to whoever actually wrote in.
  it('rejects a gift wrap whose rumor claims an author the seal does not', async () => {
    const attackerSk = generateSecretKey();
    const victimPubkey = getPublicKey(generateSecretKey());
    const result = await syncOverRelay([
      buildGiftWrap({
        sealSk: attackerSk,
        claimedPubkey: victimPubkey,
        recipientPubkey: moderatorPubkey,
        tags: [['p', moderatorPubkey]],
        content: 'I am the victim. Please unban my account.',
      }),
    ], moderatorEnv);

    expect(result).toEqual({ synced: 0, skipped: 0, errors: 1 });
    expect(await dmRows()).toHaveLength(0);
  });

  // Variant B: the attacker names the moderation account itself. Accepted,
  // this stores direction='outgoing' / message_type='moderator_reply' in the
  // victim's thread -- a fabricated enforcement statement attributed to the
  // moderation team, in the moderators' own audit trail.
  it('rejects a gift wrap whose rumor impersonates the moderation account', async () => {
    const attackerSk = generateSecretKey();
    const victimPubkey = getPublicKey(generateSecretKey());
    const result = await syncOverRelay([
      buildGiftWrap({
        sealSk: attackerSk,
        claimedPubkey: moderatorPubkey,
        recipientPubkey: moderatorPubkey,
        tags: [['p', victimPubkey]],
        content: 'Your account has been permanently banned.',
      }),
    ], moderatorEnv);

    expect(result).toEqual({ synced: 0, skipped: 0, errors: 1 });
    expect(await dmRows()).toHaveLength(0);
  });

  // Variant C: forged reporter attribution. user_reports.reporter_pubkey is
  // counted for escalation and drives the outcome-DM fanout, so a forged row
  // both mis-attributes the report and mails a stranger about it.
  it('records no report for a forged reporter', async () => {
    const attackerSk = generateSecretKey();
    const victimPubkey = getPublicKey(generateSecretKey());
    const result = await syncOverRelay([
      buildGiftWrap({
        sealSk: attackerSk,
        claimedPubkey: victimPubkey,
        recipientPubkey: moderatorPubkey,
        tags: [['p', moderatorPubkey], ['sha256', SHA256], ['report_type', 'nudity']],
        content: 'Content Report',
      }),
    ], moderatorEnv);

    expect(result).toEqual({ synced: 0, skipped: 0, errors: 1 });
    expect(await reportRows()).toHaveLength(0);
    expect(await dmRows()).toHaveLength(0);
  });

  // The positive twin of Variant C, and the end-to-end proof of what #215 is
  // actually about: a genuine report (seal == rumor, carrying the sha256 +
  // report_type tags) must flow through unwrapVerifiedRumor and land a
  // user_reports row credited to the seal-verified sender. Without this, the
  // suite only ever asserts that forged reports are *dropped*; it never pins
  // that honest reports are still *recorded*, and under the right pubkey --
  // the value that feeds escalation counting and the outcome-DM fanout.
  it('records a legitimate report under the seal-verified reporter', async () => {
    const senderSk = generateSecretKey();
    const senderPubkey = getPublicKey(senderSk);
    const result = await syncOverRelay([
      wrapEvent(
        {
          kind: 14,
          content: 'Content Report',
          tags: [['p', moderatorPubkey], ['sha256', SHA256], ['report_type', 'nudity']],
          created_at: nowSeconds(),
        },
        senderSk,
        moderatorPubkey,
      ),
    ], moderatorEnv);

    expect(result).toEqual({ synced: 1, skipped: 0, errors: 0 });
    const reports = await reportRows();
    expect(reports).toHaveLength(1);
    expect(reports[0].reporter_pubkey).toBe(senderPubkey);
    expect(reports[0].sha256).toBe(SHA256);
    expect(reports[0].source).toBe('dm-report');
  });

  // The seal is the only layer that carries the sender's real signature, so
  // an unverified one would let an attacker name any author they liked in
  // both the seal and the rumor and still satisfy the comparison above.
  it('rejects a gift wrap whose seal carries an invalid signature', async () => {
    const attackerSk = generateSecretKey();
    const result = await syncOverRelay([
      buildGiftWrap({
        sealSk: attackerSk,
        claimedPubkey: getPublicKey(attackerSk), // consistent -- only the sig is bad
        recipientPubkey: moderatorPubkey,
        tags: [['p', moderatorPubkey]],
        content: 'seal signature does not check out',
        corruptSealSig: true,
      }),
    ], moderatorEnv);

    expect(result).toEqual({ synced: 0, skipped: 0, errors: 1 });
    expect(await dmRows()).toHaveLength(0);
  });

  // NIP-59 s2: the sender's signature belongs on a kind:13. Accepting another
  // kind here would mean accepting a layer whose semantics we haven't checked.
  it('rejects a gift wrap whose inner event is not a kind:13 seal', async () => {
    const attackerSk = generateSecretKey();
    const result = await syncOverRelay([
      buildGiftWrap({
        sealSk: attackerSk,
        claimedPubkey: getPublicKey(attackerSk),
        recipientPubkey: moderatorPubkey,
        tags: [['p', moderatorPubkey]],
        content: 'inner event is not a seal',
        sealKind: 1,
      }),
    ], moderatorEnv);

    expect(result).toEqual({ synced: 0, skipped: 0, errors: 1 });
    expect(await dmRows()).toHaveLength(0);
  });

  // The gift wrap's own signature says nothing about the sender (it is a
  // throwaway key by construction), but verifying it binds giftWrap.id to the
  // wrap's contents -- and that id is dm_log's dedup key, so an id that isn't
  // bound to anything is an id an attacker can pre-claim to suppress a later
  // genuine message.
  it('rejects a gift wrap whose own signature is invalid', async () => {
    const senderSk = generateSecretKey();
    const giftWrap = wrapEvent(
      { kind: 14, content: 'tampered wrap', tags: [['p', moderatorPubkey]], created_at: nowSeconds() },
      senderSk,
      moderatorPubkey,
    );
    const result = await syncOverRelay(
      [{ ...giftWrap, sig: flipLastHexDigit(giftWrap.sig) }],
      moderatorEnv,
    );

    expect(result).toEqual({ synced: 0, skipped: 0, errors: 1 });
    expect(await dmRows()).toHaveLength(0);
  });

  // A dropped message is a real person's message that never reached a human,
  // so the drop must at least be visible in the logs. It is not silent: the
  // reader's existing per-event catch reports it with the gift wrap id.
  it('logs a rejected gift wrap rather than dropping it silently', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const giftWrap = buildGiftWrap({
        sealSk: generateSecretKey(),
        claimedPubkey: getPublicKey(generateSecretKey()),
        recipientPubkey: moderatorPubkey,
        tags: [['p', moderatorPubkey]],
        content: 'forged',
      });

      await syncOverRelay([giftWrap], moderatorEnv);

      const logged = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain(giftWrap.id);
      expect(logged).toContain('seal');
    } finally {
      errorSpy.mockRestore();
    }
  });

  // One forgery among real traffic must not cost the real messages: the
  // reader processes gift wraps independently and a rejection is one error,
  // not an aborted sync.
  it('drops only the forgery when it arrives alongside legitimate DMs', async () => {
    const senderSk = generateSecretKey();
    const senderPubkey = getPublicKey(senderSk);
    const attackerSk = generateSecretKey();
    const result = await syncOverRelay([
      buildGiftWrap({
        sealSk: attackerSk,
        claimedPubkey: getPublicKey(generateSecretKey()),
        recipientPubkey: moderatorPubkey,
        tags: [['p', moderatorPubkey]],
        content: 'forged',
      }),
      wrapEvent(
        { kind: 14, content: 'genuine', tags: [['p', moderatorPubkey]], created_at: nowSeconds() },
        senderSk,
        moderatorPubkey,
      ),
    ], moderatorEnv);

    expect(result).toEqual({ synced: 1, skipped: 0, errors: 1 });
    const rows = await dmRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('genuine');
    expect(rows[0].sender_pubkey).toBe(senderPubkey);
  });
});
