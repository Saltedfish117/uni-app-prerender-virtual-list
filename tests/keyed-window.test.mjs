import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyedWindow, encodeRenderKey } from '../assets/uni-list-adapter.js';
import { createVirtualListController } from '../assets/virtual-list-controller.js';

const node = (key, top = 0, text = 'Synthetic text') => ({
  key, data: { text }, rect: { top, height: 40, bottom: top + 40 },
});

test('native render keys preserve identifier types and avoid data path syntax', () => {
  const keys = [1, '1', 'a.b[0]', '__proto__', 'constructor', 's_0031', '合成😀', '\ud800', '\udfff', 'a_b', -2.5, 1e+30];
  const encoded = keys.map(encodeRenderKey);
  assert.equal(new Set(encoded).size, keys.length);
  encoded.forEach((key) => assert.match(key, /^[sn]_[0-9a-f]+$/));
  const window = buildKeyedWindow(keys.map((key, index) => node(key, index * 40)));
  assert.deepEqual(window.visibleKeys.map((key) => window.visibleNodes[key].key), keys);
  assert.deepEqual(JSON.parse(JSON.stringify(window)), window);
  assert.equal(Object.getPrototypeOf(window.visibleNodes), Object.prototype);
});

test('a moving window keeps surviving node identity and correct keyed content and positions', () => {
  const first = buildKeyedWindow([node('a', 0), node('b', 40), node('c', 80)]);
  const next = buildKeyedWindow([node('b', 40, 'Updated synthetic text'), node('c', 80), node('d', 120)]);
  assert.equal(first.visibleKeys[1], next.visibleKeys[0]);
  assert.equal(first.visibleKeys[2], next.visibleKeys[1]);
  assert.equal(next.visibleNodes[next.visibleKeys[0]].data.text, 'Updated synthetic text');
  assert.equal(next.visibleNodes[next.visibleKeys[0]].style, 'height:40px;transform:translateY(40px);');
  assert.equal(next.visibleNodes[next.visibleKeys[2]].style, 'height:40px;transform:translateY(120px);');
  assert.equal(Object.hasOwn(next.visibleNodes, first.visibleKeys[0]), false);
  assert.equal(first.visibleNodes[first.visibleKeys[1]].data.text, 'Synthetic text');
});

test('layout replacement updates surviving key geometry without mutating controller snapshots', () => {
  const controller = createVirtualListController({ mode: 'fixed', bufferScreens: 0 });
  const rows = [{ key: 'synthetic-a', data: { text: 'A' } }, { key: 'synthetic-b', data: { text: 'B' } }];
  const first = controller.replaceLayout(rows, { viewportHeight: 200, rowHeight: 40 });
  const firstWindow = buildKeyedWindow(first.visibleList);
  const next = controller.replaceLayout(rows, { viewportHeight: 200, rowHeight: 64 });
  const nextWindow = buildKeyedWindow(next.visibleList);
  assert.deepEqual(firstWindow.visibleKeys, nextWindow.visibleKeys);
  assert.equal(nextWindow.visibleNodes[nextWindow.visibleKeys[1]].style, 'height:64px;transform:translateY(64px);');
  assert.equal(first.visibleList[1].rect.top, 40);
  assert.equal(Object.hasOwn(first.visibleList[1], 'style'), false);
  controller.destroy();
});

test('window cache stays bounded to the current visible nodes, including empty windows', () => {
  let window;
  for (let offset = 0; offset < 1000; offset += 1) {
    window = buildKeyedWindow([node(`synthetic-${offset}`, offset * 40), node(`synthetic-${offset + 1}`, (offset + 1) * 40)]);
    assert.equal(Object.keys(window.visibleNodes).length, 2);
  }
  assert.deepEqual(buildKeyedWindow([]), { visibleKeys: [], visibleNodes: {} });
});

test('invalid or colliding identities cannot produce a renderable window', () => {
  for (const key of ['', null, undefined, {}, NaN, Infinity, false]) {
    assert.throws(() => buildKeyedWindow([node(key)]));
  }
  assert.throws(() => buildKeyedWindow([node('a'), node('a')]), /Duplicate/);
  assert.throws(() => buildKeyedWindow([node(-0), node(0)]), /Duplicate/);
  assert.throws(() => buildKeyedWindow([node('a', NaN)]));
  assert.throws(() => buildKeyedWindow([{ ...node('a'), rect: { top: 0, height: 0 } }]));
});
