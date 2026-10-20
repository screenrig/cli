import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardExpiry } from './card-expiry.js';
test('expiry flags preserve an absolute instant and bound TTL without a local clock dependency', () => {
  assert.deepEqual(cardExpiry({'ttl':'30m'}), {ttl_seconds:1800});
  assert.deepEqual(cardExpiry({'expires-at':'2026-10-20T12:00:00-07:00'}), {expires_at:'2026-10-20T19:00:00.000Z'});
  assert.deepEqual(cardExpiry({}), {});
  const invalid: Record<string, string | boolean>[] = [{ttl:'0'}, {ttl:'366d'}, {ttl:'1.2h'}, {ttl:'1h','expires-at':'2026-10-20T00:00:00Z'}, {'expires-at':'2026-10-20'}];
  for (const flags of invalid) assert.throws(() => cardExpiry(flags));
});
