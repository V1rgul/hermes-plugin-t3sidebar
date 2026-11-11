import test from 'node:test';
import assert from 'node:assert/strict';
import { bankedRedeemable } from '../desktop/plugin.js';

const win = (remaining, scope = 'account') => ({ key: `w${remaining}`, scope, remaining_percent: remaining });

test('an unknown account reading leaves redemption undecided unless a known one is already below 80%', () => {
  assert.equal(bankedRedeemable([win(90), win(null)]), null, 'one allowance at 90% and one unknown does not establish that every allowance has 80% or more');
  assert.equal(bankedRedeemable([win(undefined), win(85), win(80)]), null);
  assert.equal(bankedRedeemable([win(90), win(null), win(50)]), true, 'a known allowance below 80% is enough whatever the others read');
  assert.equal(bankedRedeemable([win(90), win(80)]), false, 'every account allowance known and at 80% or more');
  assert.equal(bankedRedeemable([win(90), win(null, 'model')]), false, 'model windows do not count, known or not');
  assert.equal(bankedRedeemable([win(null, 'model')]), null);
});
