// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// When a new input runs the page's action by itself (shared/autorun.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { onInput, runQueued } from '../../shared/autorun.js';

test('the first download waits for the button; afterwards an input runs at once', () => {
  assert.equal(onInput({ busy: false, consented: false, stored: false }), 'wait', 'nothing agreed, nothing stored: the button');
  assert.equal(onInput({ busy: false, consented: false, stored: true }), 'run', 'the model is in this browser');
  assert.equal(onInput({ busy: false, consented: true, stored: false }), 'run', 'the download was agreed on this page');
});

test('an input while an action runs is queued; a blocked page never runs by itself', () => {
  assert.equal(onInput({ busy: true, consented: true, stored: true }), 'queue');
  assert.equal(onInput({ busy: true, consented: false, stored: false }), 'queue');
  for (const busy of [false, true]) {
    assert.equal(onInput({ busy, consented: true, stored: true, blocked: true }), 'wait', `blocked, busy=${busy}`);
  }
});

test('the queued input runs after the action, never after a cancel', () => {
  assert.equal(runQueued({ queued: true, aborted: false }), true);
  assert.equal(runQueued({ queued: true, aborted: true }), false);
  assert.equal(runQueued({ queued: false, aborted: false }), false);
});
