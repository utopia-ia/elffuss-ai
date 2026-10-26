// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// When a new input (an image chosen, dropped or pasted, a folder, the camera's
// picture) may run the page's action by itself, with no click. The first
// download needs the person's consent: the primary button, which says what it
// downloads and its size. Once the model is in this browser (the store says it
// has every file of the variant), or once the person has pressed the button on
// this page, a new input runs at once. An input that arrives while an action is
// running is run right after it. No DOM here.

/**
 * @param {{ busy: boolean, consented: boolean, stored: boolean, blocked?: boolean }} s
 *   `consented`: the primary button was pressed on this page; `stored`: the
 *   store answered and has every file; `blocked`: this browser cannot run the
 *   model (or there is no input to run on).
 * @returns {'queue'|'run'|'wait'} `queue`: run after the action in progress;
 *   `run`: run now; `wait`: leave it to the primary button.
 */
export function onInput({ busy, consented, stored, blocked = false }) {
  if (blocked) return 'wait';
  if (busy) return 'queue';
  return consented || stored ? 'run' : 'wait';
}

/**
 * After an action ends: whether the input that arrived meanwhile runs now.
 * Never after a cancel, which says the person wants it to stop.
 * @param {{ queued: boolean, aborted: boolean }} s
 */
export function runQueued({ queued, aborted }) {
  return Boolean(queued && !aborted);
}
