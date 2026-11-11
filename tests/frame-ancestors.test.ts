import assert from 'node:assert/strict';
import { test } from 'node:test';

import { frameAncestors } from '../server/config.js';

test('frameAncestors ne garde que des origines https exactes', () => {
  assert.deepEqual(frameAncestors(undefined), []);
  assert.deepEqual(frameAncestors(''), []);
  assert.deepEqual(
    frameAncestors(' https://ha.exemple.be , http://ha.exemple.be, https://ha.exemple.be/lovelace, *, https://b.be:8443'),
    ['https://ha.exemple.be', 'https://b.be:8443'],
  );
});
