#!/usr/bin/env node
// Sign a NIP-98 Authorization header for testing creator-delete endpoints.
// Usage (CLI): node scripts/sign-nip98.mjs --nsec <hex> --url <url> --method <POST|GET>
// Usage (import): import { signNip98Header } from './sign-nip98.mjs'

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';

/**
 * Sign a NIP-98 Authorization header. Returns the full "Nostr <base64>" header value.
 * Importable from other scripts; see CLI entry point below for standalone use.
 */
export function signNip98Header(sk, url, method) {
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', method.toUpperCase()]],
    content: ''
  }, sk);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

// CLI entrypoint — skipped when imported by tests.
const isMain = typeof process !== 'undefined' && process.argv && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  };

  const nsecHex = getArg('nsec');
  const sk = nsecHex ? hexToBytes(nsecHex) : generateSecretKey();
  if (!nsecHex) {
    console.error(`No --nsec provided. Generated ephemeral key. Pubkey: ${getPublicKey(sk)}`);
  }

  const url = getArg('url');
  const method = (getArg('method') || 'POST').toUpperCase();

  if (!url) {
    console.error('Usage: node scripts/sign-nip98.mjs --nsec <hex> --url <url> [--method POST]');
    process.exit(1);
  }

  const header = signNip98Header(sk, url, method);

  // Decode the event from the header to get the event ID for logging
  const eventJson = Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8');
  const event = JSON.parse(eventJson);

  // Print just the header value (for use in curl -H "Authorization: <output>")
  console.log(header);

  // Metadata to stderr so it doesn't pollute the header output
  console.error(`Pubkey: ${getPublicKey(sk)}`);
  console.error(`URL: ${url}`);
  console.error(`Method: ${method}`);
  console.error(`Event ID: ${event.id}`);
}
