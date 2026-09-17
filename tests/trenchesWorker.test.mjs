import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrenchesHtml } from '../src/signals/trenchesWorker.mjs';

test('parses CircleTrenches-style token aggregate rows', () => {
  const address = '0x06f7aeab1234567890abcdef1234567890127777';
  const html = `
    <table>
      <thead><tr><th>TOKEN</th><th>WALLETS THAT BOUGHT</th><th>STILL HOLDING</th><th>SPENT</th><th>TOOK OUT</th><th>NET INTO IT</th><th>FIRST IN</th><th>PRICE SINCE FIRST BUY</th><th>24H</th><th>MCAP</th><th>POOL LIQUIDITY</th><th>dexscreener</th><th>ca</th></tr></thead>
      <tbody>
        <tr>
          <td>UPONLY</td><td>8</td><td>4</td><td>$138,583</td><td>$25,148</td><td>+$113,435</td><td>DNS_ERR</td><td>+12.5%</td><td>+22.0%</td><td>$1.86M</td><td>$185,802</td>
          <td><a href="https://dexscreener.com/bsc/${address}">dex</a></td><td>${address}</td>
        </tr>
      </tbody>
    </table>`;

  const rows = parseTrenchesHtml(html, 'https://circletrenches.com/');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'UPONLY');
  assert.equal(rows[0].chain, 'bsc');
  assert.equal(rows[0].address, address);
  assert.equal(rows[0].walletsBought, 8);
  assert.equal(rows[0].stillHolding, 4);
  assert.equal(rows[0].netInflowUsd, 113435);
  assert.equal(rows[0].marketCapUsd, 1_860_000);
  assert.equal(rows[0].liquidityUsd, 185_802);
  assert.equal(rows[0].priceSinceFirstBuyPct, 12.5);
});

test('ignores unrelated rows without a full EVM token address', () => {
  const html = '<table><tr><td>NOTTOKEN</td><td>5</td><td>5</td><td>$1K</td><td>$0</td><td>+$1K</td><td>A</td><td>+1%</td><td>+2%</td><td>$10K</td><td>$9K</td><td>—</td><td>0x1234…abcd</td></tr></table>';
  assert.deepEqual(parseTrenchesHtml(html), []);
});
