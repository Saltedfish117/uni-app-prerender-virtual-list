import test from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualListController } from '../assets/virtual-list-controller.js';
import { createUniListAdapter, readPageLayout, readScrollViewLayout, readScrollViewOffset } from '../assets/uni-list-adapter.js';

// All records, coordinates and identifiers below are synthetic test fixtures.
const rows = (count = 100) => Array.from({ length: count }, (_, index) => ({ key: `demo-${index}`, data: { text: `Sample ${index}` } }));
const layout = (listTop = 200, scrollTop = 0, rowHeight = 20) => ({
  listTop, scrollTop, metrics: { rowHeight, viewportHeight: 100, topInset: 0 },
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function harness(overrides = {}) {
  const publications = [];
  const samples = [];
  const errors = [];
  const layouts = [];
  let nodes = rows();
  const controller = createVirtualListController({ mode: 'fixed', bufferScreens: 0, throttleMs: 0, onUpdate: (value) => publications.push(value) });
  const adapter = createUniListAdapter({
    controller, nextTick: () => Promise.resolve(), getNodes: () => nodes,
    getSample: () => ({ text: 'Synthetic measurement sample' }), onSample: (value) => samples.push(value),
    readLayout: async () => layout(), onLayout: (value) => layouts.push(value), onError: (value) => errors.push(value),
    ...overrides,
  });
  return { controller, adapter, publications, samples, errors, layouts, setNodes: (value) => { nodes = value; } };
}

async function activate(adapter) {
  assert.equal(await adapter.onShow(), false);
  return adapter.onReady();
}

// Query fake models uni-app's single batched selector execution. Results are
// selected by surface and requested measurement, not copied from helper code.
function queryFixture(records) {
  const batches = [];
  let executions = 0;
  const query = () => {
    const requests = [];
    const batch = {
      in(scope) { assert.ok(scope); return this; },
      select(selector) {
        return {
          boundingClientRect() { requests.push([selector, 'rect']); return batch; },
          scrollOffset() { requests.push([selector, 'offset']); return batch; },
        };
      },
      selectViewport() { return this.select('viewport'); },
      exec(callback) {
        executions += 1;
        batches.push(requests.slice());
        callback(requests.map(([selector, kind]) => records[selector]?.[kind] ?? null));
      },
    };
    return batch;
  };
  return { query, batches, executions: () => executions };
}

test('page coordinates pair list rect with viewport offset in one query', async () => {
  const fixture = queryFixture({
    '#sample': { rect: { width: 320, height: 56 } },
    '#list': { rect: { width: 320, top: -640 } },
    viewport: { offset: { scrollTop: 900 } },
  });
  const result = await readPageLayout({ query: fixture.query, scope: {}, listSelector: '#list', sampleSelectors: { item: '#sample' }, viewportHeight: 600 });
  assert.equal(fixture.executions(), 1);
  assert.equal(result.listTop, 260);
  assert.equal(result.scrollTop - result.listTop, 640);
  assert.deepEqual(result.metrics, { rowHeight: 56, viewportHeight: 600, topInset: 0 });
});

test('container coordinates use its own offset and actual client height', async () => {
  const fixture = queryFixture({
    '#heading': { rect: { width: 300, height: 40 } },
    '#row': { rect: { width: 300, height: 60 } },
    '#list': { rect: { width: 300, top: -280 } },
    '#scroll': { rect: { width: 300, top: 160, height: 420 }, offset: { scrollTop: 500 } },
    viewport: { offset: { scrollTop: 10000 } },
  });
  const result = await readScrollViewLayout({ query: fixture.query, scope: {}, scrollSelector: '#scroll', listSelector: '#list', sampleSelectors: { heading: '#heading', row: '#row' }, topInset: 40 });
  assert.equal(fixture.executions(), 1);
  assert.equal(result.listTop, 60);
  assert.equal(result.scrollTop - result.listTop, 440);
  assert.deepEqual(result.metrics, { viewportHeight: 420, topInset: 40, heightByType: { heading: 40, row: 60 } });
  assert.ok(fixture.batches.flat().every(([selector]) => selector !== 'viewport'));
  assert.equal(await readScrollViewOffset({ query: fixture.query, scope: {}, scrollSelector: '#scroll' }), 500);
});

test('invalid or mismatched measurement cannot become usable metrics', async () => {
  for (const sample of [{ width: 320, height: 0 }, { width: 200, height: 56 }, null]) {
    const fixture = queryFixture({ '#sample': { rect: sample }, '#list': { rect: { width: 320, top: 0 } }, viewport: { offset: { scrollTop: 0 } } });
    await assert.rejects(readPageLayout({ query: fixture.query, scope: {}, listSelector: '#list', sampleSelectors: { item: '#sample' }, viewportHeight: 600 }));
  }
});

test('ready and active gate measurement; negative list-local positions are preserved', async () => {
  let reads = 0;
  const h = harness({ readLayout: async () => { reads += 1; return layout(300, 0); } });
  assert.equal(await h.adapter.onReady(), false);
  assert.equal(reads, 0);
  assert.equal(await h.adapter.onShow(), true);
  assert.equal(reads, 1);
  assert.equal(h.adapter.getLocalScrollTop(), -300);
  assert.equal(h.controller.getSnapshot().visibleList.length, 0);
  assert.equal(h.publications.length, 1);
  h.adapter.dispose();
});

test('new scroll events win over a pending measurement offset', async () => {
  const waiting = deferred();
  const h = harness({ readLayout: () => waiting.promise });
  await h.adapter.onShow();
  const pending = h.adapter.onReady();
  await flush();
  h.adapter.handleScroll(900);
  waiting.resolve(layout(200, 400));
  assert.equal(await pending, true);
  assert.equal(h.adapter.getScrollTop(), 900);
  assert.equal(h.adapter.getLocalScrollTop(), 700);
  assert.equal(h.controller.getSnapshot().start, 35);
  h.adapter.dispose();
});

test('obsolete measurement and finally cannot replace or hide a newer sample', async () => {
  const first = deferred();
  const second = deferred();
  let reads = 0;
  let sampleNumber = 0;
  const h = harness({
    getSample: () => ({ text: `Synthetic sample ${++sampleNumber}` }),
    readLayout: () => (++reads === 1 ? first.promise : second.promise),
  });
  await h.adapter.onShow();
  const oldWork = h.adapter.onReady();
  await flush();
  const newWork = h.adapter.measure();
  await flush();
  first.resolve(layout(50, 0, 10));
  assert.equal(await oldWork, false);
  assert.equal(h.samples.at(-1).text, 'Synthetic sample 2');
  assert.equal(h.publications.length, 0);
  second.resolve(layout(200, 240, 40));
  assert.equal(await newWork, true);
  assert.equal(h.samples.at(-1), null);
  assert.equal(h.controller.getSnapshot().totalHeight, 4000);
  assert.equal(h.layouts.length, 1);
  h.adapter.dispose();
});

test('hide during nextTick prevents query and show measures again', async () => {
  const tick = deferred();
  let reads = 0;
  const h = harness({ nextTick: () => tick.promise, readLayout: async () => { reads += 1; return layout(); } });
  await h.adapter.onShow();
  const pending = h.adapter.onReady();
  h.adapter.onHide();
  tick.resolve();
  assert.equal(await pending, false);
  assert.equal(reads, 0);
  assert.equal(h.samples.at(-1), null);
  assert.equal(await h.adapter.onShow(), true);
  assert.equal(reads, 1);
  h.adapter.dispose();
});

test('dispose during query prevents late publication or error state writes', async () => {
  const query = deferred();
  const h = harness({ readLayout: () => query.promise });
  await h.adapter.onShow();
  const pending = h.adapter.onReady();
  await flush();
  h.adapter.dispose();
  h.adapter.dispose();
  const sampleCount = h.samples.length;
  const errorCount = h.errors.length;
  query.reject(new Error('Synthetic late query failure'));
  assert.equal(await pending, false);
  assert.equal(h.publications.length, 0);
  assert.equal(h.samples.length, sampleCount);
  assert.equal(h.errors.length, errorCount);
  assert.equal(await h.adapter.onShow(), false);
  h.adapter.handleScroll(1000);
  assert.equal(h.adapter.isActive(), false);
});

test('measurement errors clear readiness, retain pause, and allow retry', async () => {
  let fail = true;
  const h = harness({ readLayout: async () => { if (fail) throw new Error('Synthetic query failure'); return layout(0, 20); } });
  assert.equal(await activate(h.adapter), false);
  assert.equal(h.adapter.getLayout(), null);
  assert.match(h.errors.at(-1).message, /Synthetic query/);
  assert.equal(h.samples.at(-1), null);
  assert.equal(h.publications.length, 0);
  fail = false;
  assert.equal(await h.adapter.measure(), true);
  assert.equal(h.publications.length, 1);
  h.adapter.dispose();
});

test('sample construction failure uses the same retry path as query failure', async () => {
  let fail = true;
  const h = harness({ getSample: () => { if (fail) throw new Error('Synthetic sample unavailable'); return { text: 'Synthetic sample' }; } });
  assert.equal(await activate(h.adapter), false);
  assert.match(h.errors.at(-1).message, /sample unavailable/);
  assert.equal(h.samples.at(-1), null);
  fail = false;
  assert.equal(await h.adapter.measure(), true);
  h.adapter.dispose();
});

test('data changes refresh an unchanged window without remeasuring', async () => {
  let reads = 0;
  const h = harness({ readLayout: async () => { reads += 1; return layout(0, 0); } });
  await activate(h.adapter);
  const before = h.controller.getSnapshot();
  const next = rows();
  next[0] = { ...next[0], data: { text: 'Updated synthetic text' } };
  h.setNodes(next);
  assert.equal(h.adapter.refreshData(), true);
  const after = h.controller.getSnapshot();
  assert.equal(reads, 1);
  assert.equal(after.start, before.start);
  assert.equal(after.endExclusive, before.endExclusive);
  assert.notEqual(after.visibleList, before.visibleList);
  assert.equal(after.visibleList[0].data.text, 'Updated synthetic text');
  h.setNodes([]);
  h.adapter.refreshData();
  assert.equal(h.controller.getSnapshot().totalHeight, 0);
  assert.equal(h.controller.getSnapshot().visibleList.length, 0);
  h.adapter.dispose();
});

test('resize replaces measured height and page origin together', async () => {
  let nextLayout = layout(100, 400, 20);
  const h = harness({ readLayout: async () => nextLayout });
  await activate(h.adapter);
  nextLayout = layout(140, 400, 30);
  await h.adapter.onResize();
  assert.equal(h.adapter.getLocalScrollTop(), 260);
  assert.equal(h.controller.getSnapshot().totalHeight, 3000);
  assert.equal(h.controller.getSnapshot().start, 8);
  h.adapter.dispose();
});
