import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import plugin, * as flow from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const storage = mock.ctx.storage;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
let root;

// A Web Audio stand-in that records what the plugin decodes and plays: T3's decoded buffer, and Desktop presets' synthesized voices. Its clock moves on every read, so separate cues never coalesce.
const audio = { starts: 0, tones: 0, closed: 0, decoded: null };
const param = () => ({ setValueAtTime() {}, exponentialRampToValueAtTime() {} });
const node = (extra = {}) => ({ connect() {}, ...extra });
dom.window.AudioContext = class {
	constructor() { this.state = 'running'; this.clock = 0; this.destination = {}; this.sampleRate = 8000; }
	get currentTime() { return this.clock += 10; }
	resume() { return Promise.resolve(); }
	close() { audio.closed++; return Promise.resolve(); }
	decodeAudioData(buffer) { audio.decoded = new Uint8Array(buffer); return Promise.resolve({ duration: 0.4 }); }
	createBufferSource() { return node({ start() { audio.starts++; }, stop() {} }); }
	createOscillator() { return node({ frequency: param(), detune: param(), start() { audio.tones++; }, stop() {} }); }
	createGain() { return node({ gain: param() }); }
	createBiquadFilter() { return node({ frequency: param(), Q: param() }); }
	createConvolver() { return node(); }
	createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
};
globalThis.localStorage = dom.window.localStorage;

afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	mock.control.disposers?.forEach(dispose => dispose());
	mock.ctx.storage = storage; mock.reset(); localStorage.clear();
	Object.assign(audio, { starts: 0, tones: 0, closed: 0, decoded: null });
});

async function mountSidebar(sound) {
	storage.set('completion-sound', sound);
	plugin.register(mock.ctx);
	root = createRoot(document.querySelector('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions[0].render())));
	await tick(); await tick();
}
async function poll() { await act(async () => mock.queryClient.invalidateQueries({ queryKey: flow.scopeKey(flow.captureScope()) })); await tick(); await tick(); }
const marker = token => ({ done_token: token, done_at: Date.now() / 1000 });

test('the T3 sound plays when a card shows Done or Input, not for badges already there or a Done hidden behind Working', async () => {
	// The fixture already shows Input (approval) and Done (unread readme): loading them is silent.
	await mountSidebar('t3');
	assert.equal(audio.starts, 0);
	// The backend records a completion while the card still reads Working: Working outranks Done, no badge yet.
	mock.control.metadata.completions = { pinned: marker('turn-1') };
	mock.control.live.push({ id: 'runtime-pinned', session_key: 'pinned', status: 'working' });
	await poll();
	assert.equal(audio.starts, 0);
	mock.control.live = mock.control.live.filter(item => item.session_key !== 'pinned');
	await poll();
	assert.equal(audio.starts, 1, 'Done shows');
	// The inlined asset decodes as an MPEG audio frame, not a corrupted string.
	assert.equal(audio.decoded[0], 0xff); assert.equal(audio.decoded[1] & 0xe0, 0xe0);
	await poll();
	assert.equal(audio.starts, 1, 'one completion gives one sound');
	mock.control.live.push({ id: 'runtime-snoozed', session_key: 'snoozed', status: 'waiting' });
	await poll();
	assert.equal(audio.starts, 2, 'Input shows');
	mock.control.disposers.forEach(dispose => dispose()); mock.control.disposers = [];
	assert.equal(audio.closed, 1, 'disabling the plugin closes its audio context');
});

test('no sound with the setting on None, nor while a poll fails', async () => {
	await mountSidebar('none');
	mock.control.metadata.completions = { pinned: marker('turn-1') };
	await poll();
	assert.equal(audio.starts, 0);
	storage.set('completion-sound', 't3');
	// A failed poll leaves statuses unknown: Input disappearing and coming back is not a new question.
	mock.control.runtimeError = true;
	await poll();
	mock.control.runtimeError = false;
	await poll();
	assert.equal(audio.starts, 0);
});

const card = (key, fields = {}) => ({ key, status: 'idle', completion: null, ...fields });
const sections = rows => ({ active: rows });

test('a Done returning with the same completion stays silent; a new completion plays even for a card new to the list', () => {
	const state = {}, done = { completion: { done_token: 't1' } };
	assert.equal(flow.attentionCue(state, sections([card('a', done)]), { a: { done_token: 't1' } }), 0, 'baseline');
	// A new turn (a /loop wake-up) makes it Working and ends without a completion of its own.
	assert.equal(flow.attentionCue(state, sections([card('a', { ...done, status: 'working' })]), { a: { done_token: 't1' } }), 0);
	assert.equal(flow.attentionCue(state, sections([card('a', done)]), { a: { done_token: 't1' } }), 0);
	assert.equal(flow.attentionCue(state, sections([card('a', { completion: { done_token: 't2' } })]), { a: { done_token: 't2' } }), 1);
	// A session created since the baseline finishes its first turn.
	assert.equal(flow.attentionCue(state, sections([card('a', { completion: { done_token: 't2' } }), card('b', { completion: { done_token: 'b1' } })]), { a: { done_token: 't2' }, b: { done_token: 'b1' } }), 1);
});

test('a completion that reaches the open session while it still reads Working plays once Working ends, although its acknowledgment hid the badge', () => {
	const state = {}, scope = sections;
	flow.attentionCue(state, scope([card('a', { status: 'working' })]), {});
	assert.equal(flow.attentionCue(state, scope([card('a', { status: 'working', completion: { done_token: 't1' } })]), { a: { done_token: 't1' } }), 0);
	// Acknowledged by the open session before the runtime caught up.
	assert.equal(flow.attentionCue(state, scope([card('a', { status: 'working' })]), {}), 0);
	assert.equal(flow.attentionCue(state, scope([card('a')]), {}), 1);
	assert.equal(flow.attentionCue(state, scope([card('a')]), {}), 0);
	// Ending on a question plays once, for the question.
	flow.attentionCue(state, scope([card('a', { status: 'working', completion: { done_token: 't2' } })]), { a: { done_token: 't2' } });
	assert.equal(flow.attentionCue(state, scope([card('a', { status: 'waiting' })]), {}), 1);
	assert.equal(flow.attentionCue(state, scope([card('a')]), {}), 0);
});

test('older history loaded later brings its badges without a sound', () => {
	const state = {};
	flow.attentionCue(state, sections([card('a')]), { old: { done_token: 'o1' } });
	assert.equal(flow.attentionCue(state, sections([card('a'), card('old', { completion: { done_token: 'o1' } }), card('older', { unread: true }), card('asking', { status: 'waiting' })]), { old: { done_token: 'o1' } }), 0);
	assert.equal(flow.attentionCue(state, sections([card('a', { status: 'waiting' })]), {}), 1, 'a card already listed asks a question');
});

async function mountSettings(sound) {
	storage.set('completion-sound', sound);
	plugin.register(mock.ctx);
	root = createRoot(document.querySelector('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.settings.render())));
	await tick();
}
const nativeButton = () => document.querySelector('.sf-native');
const nativeState = () => [document.querySelector('.sf-native-hint').dataset.state, document.querySelector('.sf-native-hint').textContent];
async function nativeChanges(key, value) { localStorage.setItem(key, value); await act(async () => window.dispatchEvent(new window.Event('storage'))); }

test("the Desktop sound button reads Desktop's own setting: highlighted while it plays, green once None or muted, and opens that setting", async () => {
	await mountSettings('none');
	assert.deepEqual(nativeState(), ['neutral', 'Only Desktop’s own Completion Sound plays (Two-note comfort).'], 'nothing conflicts while this sound is off');
	const picker = document.querySelector('select[aria-label="Done/Input sound"]');
	assert.deepEqual([...picker.options].slice(0, 3).map(option => option.textContent), ['None', '★ T3 Code', 'Two-note comfort']);
	assert.equal(picker.options.length, 16, "None, T3 Code and Desktop's 14 presets");
	// Choosing a Desktop preset stores it and plays it, as Desktop's own picker does.
	await act(async () => { picker.value = 'hermes-3'; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
	await tick();
	assert.equal(storage.get('completion-sound'), 'hermes-3');
	assert.ok(audio.tones > 0); assert.equal(audio.starts, 0, 'no T3 recording for a Desktop preset');
	// Desktop never stored a choice: its default preset plays.
	assert.deepEqual(nativeState(), ['warn', 'Desktop sound is not None (Two-note comfort): both will play at the same time. Set it to None.']);
	await nativeChanges('hermes.desktop.completionSoundVariantId', '0');
	assert.deepEqual(nativeState(), ['ok', 'Desktop sound is None: only this one plays.']);
	await nativeChanges('hermes.desktop.completionSoundVariantId', '13');
	assert.deepEqual(nativeState(), ['warn', 'Desktop sound is not None (Sonar ping): both will play at the same time. Set it to None.']);
	await nativeChanges('hermes.desktop.hapticsMuted', 'true');
	assert.equal(nativeState()[0], 'ok');
	await nativeChanges('hermes.desktop.completionSoundVariantId', 'renamed');
	assert.equal(nativeState()[0], 'unknown', 'an unreadable value is not presented as on or off');
	await act(async () => nativeButton().click());
	assert.deepEqual(mock.calls.at(-1), ['navigate', '/settings?tab=notifications&page=sounds&setting=completionSound']);
});

test("the automatic sound plays the chosen Desktop preset and respects Desktop's Mute interface sounds", async () => {
	localStorage.setItem('hermes.desktop.hapticsMuted', 'true');
	await mountSidebar('hermes-12');
	mock.control.metadata.completions = { pinned: marker('turn-1') };
	await poll();
	assert.equal(audio.tones, 0, 'muted');
	localStorage.setItem('hermes.desktop.hapticsMuted', 'false');
	mock.control.metadata.completions = { pinned: marker('turn-2') };
	await poll();
	assert.ok(audio.tones > 0); assert.equal(audio.starts, 0);
});

test('the player reports a sound as playing until its last voice stops, and refuses another meanwhile', async () => {
	// Timers held by the test, so the playing span is read from what the player schedules, and a clock that moves only when told.
	const timers = [];
	let clock;
	const Still = class extends dom.window.AudioContext { constructor() { super(); clock = this; } get currentTime() { return this.clock; } };
	const win = { AudioContext: Still, atob: dom.window.atob, setTimeout: (run, ms) => timers.push({ run, ms }) - 1, clearTimeout: id => { if (timers[id]) timers[id].cleared = true; } };
	const player = flow.createSoundPlayer(win), seen = [];
	player.subscribe(() => seen.push(player.playing()));
	const bowl = `hermes-${flow.HERMES_SOUNDS.findIndex(sound => sound?.name === 'Singing bowl')}`;
	assert.equal(await player.play(bowl), true);
	assert.deepEqual(seen, [true]);
	// Its first voice swells and fades over 0.58 + 0.16 + 1.35 s, well past a fixed guess.
	assert.ok(timers[0].ms > 2090 && timers[0].ms < 2150, `${timers[0].ms} ms`);
	assert.equal(await player.play('t3'), false, 'a cue started while one plays is dropped');
	clock.clock += 2.2; timers[0].run();
	assert.deepEqual(seen, [true, false]);
	assert.equal(await player.play('t3'), true);
	assert.equal(timers[1].ms, 400, "T3's recording lasts its decoded duration");
	player.dispose();
	assert.deepEqual(seen, [true, false, true, false], 'disposing ends the playing state');
});

test('the Preview button is disabled while a sound plays', async () => {
	await mountSettings('hermes-8');
	const preview = [...document.querySelectorAll('button')].find(node => node.textContent.includes('Preview'));
	assert.equal(preview.disabled, false);
	await act(async () => preview.click());
	await tick();
	assert.equal(preview.disabled, true);
	// IBM terminal ends 0.26 s after it starts.
	await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
	assert.equal(preview.disabled, false);
});

test('two sessions finishing in the same poll give one sound each', async () => {
	await mountSidebar('t3');
	mock.control.metadata.completions = { pinned: marker('turn-1'), snoozed: marker('turn-2') };
	await poll();
	assert.equal(audio.starts, 2);
});

test('a notification arriving while one plays waits for it instead of being dropped; disposing drops the rest', async () => {
	const timers = [];
	let clock;
	const Still = class extends dom.window.AudioContext { constructor() { super(); clock = this; } get currentTime() { return this.clock; } };
	const win = { AudioContext: Still, atob: dom.window.atob, setTimeout: (run, ms) => timers.push({ run, ms }) - 1, clearTimeout() {} };
	const player = flow.createSoundPlayer(win);
	await player.queue('t3');
	const second = player.queue('t3'), third = player.queue('t3');
	await tick();
	assert.equal(audio.starts, 1, 'the second waits while the first plays');
	const waiting = timers.at(-1);
	assert.equal(waiting.ms, 400, 'until the first ends');
	clock.clock += 0.4; waiting.run(); await second;
	assert.equal(audio.starts, 2);
	player.dispose();
	clock.clock += 0.4; timers.at(-1).run(); await third;
	assert.equal(audio.starts, 2, 'a disposed player plays nothing more');
});
