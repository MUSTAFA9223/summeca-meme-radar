import test from 'node:test';
import assert from 'node:assert/strict';
import { holderProfileFromParsedProgramAccounts, holderProfileFromTokenAccounts } from '../src/feeds/heliusTokenHolders.mjs';

test('Helius holder profile aggregates duplicate token accounts by owner', () => {
  const profile = holderProfileFromTokenAccounts([
    { owner: 'curve', amount: 70 },
    { owner: 'alice', amount: 3 },
    { owner: 'alice', amount: 2 },
    { owner: 'bob', amount: 5 },
    { owner: 'carol', amount: 5 },
    { owner: 'dave', amount: 4 },
    { owner: 'erin', amount: 3 },
    { owner: 'frank', amount: 3 },
    { owner: 'gina', amount: 2 },
    { owner: 'hank', amount: 1 }
  ]);

  assert.equal(profile.provider, 'helius-token-accounts');
  assert.equal(profile.curveExcluded, true);
  assert.equal(profile.observedAccounts, 8);
  assert.equal(Math.round(profile.topUserPct), 5);
  assert.equal(profile.pass, true);
});

test('Helius holder profile rejects concentrated holder distributions', () => {
  const profile = holderProfileFromTokenAccounts([
    { owner: 'curve', amount: 60 },
    { owner: 'whale', amount: 20 },
    { owner: 'a', amount: 5 },
    { owner: 'b', amount: 5 },
    { owner: 'c', amount: 5 },
    { owner: 'd', amount: 5 }
  ]);

  assert.equal(profile.curveExcluded, true);
  assert.ok(profile.topUserPct > 12);
  assert.equal(profile.pass, false);
});

test('truncated Helius token-account evidence never passes the safety gate', () => {
  const profile = holderProfileFromTokenAccounts([
    { owner: 'curve', amount: 70 },
    { owner: 'a', amount: 5 },
    { owner: 'b', amount: 5 },
    { owner: 'c', amount: 5 },
    { owner: 'd', amount: 4 },
    { owner: 'e', amount: 3 },
    { owner: 'f', amount: 3 },
    { owner: 'g', amount: 2 },
    { owner: 'h', amount: 2 },
    { owner: 'i', amount: 1 }
  ], { complete: false });

  assert.equal(profile.limitedEvidence, true);
  assert.equal(profile.pass, false);
});


test('parsed getProgramAccounts rows produce a complete holder profile', () => {
  const row = (owner, amount) => ({
    account: {
      data: {
        parsed: {
          info: {
            owner,
            tokenAmount: { amount: String(amount) }
          }
        }
      }
    }
  });
  const profile = holderProfileFromParsedProgramAccounts([
    row('curve', 70),
    row('alice', 5),
    row('bob', 5),
    row('carol', 5),
    row('dave', 4),
    row('erin', 3),
    row('frank', 3),
    row('gina', 2),
    row('hank', 2),
    row('ivy', 1)
  ]);

  assert.equal(profile.provider, 'solana-getProgramAccounts');
  assert.equal(profile.complete, true);
  assert.equal(profile.pass, true);
  assert.equal(profile.observedAccounts, 9);
});
