import test from 'node:test';
import assert from 'node:assert/strict';
import { createScrollViewSync } from '../assets/scroll-view-sync.js';
import { createUniListAdapter } from '../assets/uni-list-adapter.js';
import { createVirtualListController } from '../assets/virtual-list-controller.js';

// Synthetic native offsets only; this suite does not emulate inertia or WXML.
const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class FakeClock {
  time = 0;
  serial = 0;
  pending = new Map();
  now() { return this.time; }
  setTimeout(fn, ms) {
    const id = ++this.serial;
    this.pending.set(id, { fn, at: this.time + ms });
    return id;
  }
  clearTimeout(id) { this.pending.delete(id); }
  async advance(ms) {
    await flush();
    const target = this.time + ms;
    for (;;) {
      const next = [...this.pending].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.pending.delete(next[0]);
      this.time = next[1].at;
      next[1].fn();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

function harness(options = {}) {
  const clock = new FakeClock();
  const applied = [];
  const errors = [];
  let active = true;
  let reads = 0;
  const sync = createScrollViewSync({
    clock, quietMs: 10, queryTimeoutMs: 100, maxSamples: 4,
    isActive: () => active,
    readOffset: () => { reads += 1; return options.read ? options.read(reads) : 600; },
    applyOffset: (value) => applied.push(value),
    onError: (error) => errors.push(error),
    ...options.overrides,
  });
  return { sync, clock, applied, errors, reads: () => reads, hide: () => { active = false; sync.cancel(); } };
}

test('native reads recover a missing final event and cancel an older throttled window update', async () => {
  const clock = new FakeClock();
  const controller = createVirtualListController({ mode: 'fixed', bufferScreens: 3, throttleMs: 150, clock });
  const adapter = createUniListAdapter({
    controller, nextTick: async () => {},
    getNodes: () => Array.from({ length: 1000 }, (_, index) => ({ key: `synthetic-${index}` })),
    getSample: () => ({}), onSample: () => {}, onLayout: () => {}, onError: () => {},
    readLayout: async () => ({ listTop: 60, scrollTop: 0, metrics: { viewportHeight: 100, rowHeight: 20 } }),
  });
  await adapter.onShow();
  await adapter.onReady();
  adapter.handleScroll(80);
  assert.ok(clock.pending.size > 0, 'an older throttled update is pending');
  const sync = createScrollViewSync({
    clock, quietMs: 10, readOffset: async () => 1800,
    applyOffset: (value) => adapter.syncScroll(value), isActive: () => adapter.isActive(),
  });
  const pending = sync.reconcile();
  await clock.advance(200);
  assert.equal(await pending, true);
  assert.equal(adapter.getScrollTop(), 1800);
  assert.equal(adapter.getLocalScrollTop(), 1740);
  assert.equal(controller.getSnapshot().start, 72);
  assert.equal(clock.pending.size, 0);
  sync.dispose();
  adapter.dispose();
});

test('quiet-period reads follow native motion without more events and stop once stable', async () => {
  const offsets = [500, 900, 1200, 1200];
  const h = harness({ read: (index) => offsets[index - 1] });
  const pending = h.sync.schedule();
  await h.clock.advance(9);
  assert.equal(h.reads(), 0);
  await h.clock.advance(31);
  assert.equal(await pending, true);
  assert.deepEqual(h.applied, offsets);
  assert.equal(h.clock.pending.size, 0);
});

test('new scroll events invalidate an in-flight old offset query', async () => {
  const oldRead = deferred();
  const h = harness({ read: (index) => index === 1 ? oldRead.promise : 1500 });
  const old = h.sync.reconcile();
  await flush();
  const latest = h.sync.schedule();
  oldRead.resolve(200);
  await h.clock.advance(20);
  assert.equal(await old, false);
  assert.equal(await latest, true);
  assert.deepEqual(h.applied, [1500, 1500]);
});

test('repeated events debounce native queries instead of queuing one query per event', async () => {
  const h = harness();
  const first = h.sync.schedule();
  await h.clock.advance(5);
  const second = h.sync.schedule();
  await h.clock.advance(9);
  assert.equal(h.reads(), 0);
  await h.clock.advance(11);
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(h.reads(), 2);
  assert.equal(h.clock.pending.size, 0);
});

test('continued native movement has a finite sample budget', async () => {
  const h = harness({ read: (index) => index * 500 });
  const pending = h.sync.reconcile();
  await h.clock.advance(1000);
  assert.equal(await pending, false);
  assert.equal(h.reads(), 4);
  assert.deepEqual(h.applied, [500, 1000, 1500, 2000]);
  assert.equal(h.errors.length, 0);
  assert.equal(h.clock.pending.size, 0);
});

test('hung native queries time out and late completion cannot write to the adapter', async () => {
  const waiting = deferred();
  const h = harness({ read: () => waiting.promise });
  const pending = h.sync.reconcile();
  await h.clock.advance(100);
  assert.equal(await pending, false);
  assert.match(h.errors[0].message, /timed out/);
  waiting.resolve(900);
  await flush();
  assert.deepEqual(h.applied, []);
  assert.equal(h.clock.pending.size, 0);
});

test('query failures and invalid offsets report failure without an automatic retry loop', async () => {
  for (const read of [() => Promise.reject(new Error('Synthetic read failure')), () => NaN, () => null]) {
    const h = harness({ read });
    const pending = h.sync.reconcile();
    await flush();
    assert.equal(await pending, false);
    assert.equal(h.errors.length, 1);
    assert.equal(h.reads(), 1);
    assert.deepEqual(h.applied, []);
    assert.equal(h.clock.pending.size, 0);
  }
});

test('hiding before a queued query starts prevents that query from being issued', async () => {
  const h = harness();
  const pending = h.sync.reconcile();
  h.hide();
  await flush();
  assert.equal(await pending, false);
  assert.equal(h.reads(), 0);
  assert.equal(h.clock.pending.size, 0);
});

test('dispose cancels pending queries and prevents subsequent schedule calls', async () => {
  const waiting = deferred();
  const h = harness({ read: () => waiting.promise });
  const pending = h.sync.reconcile();
  await flush();
  h.sync.dispose();
  waiting.reject(new Error('Synthetic late failure'));
  await flush();
  assert.equal(await pending, false);
  assert.equal(await h.sync.schedule(), false);
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.errors, []);
  assert.equal(h.clock.pending.size, 0);
});

test('repeated resets toggle bound values and sync native position before the caller refreshes data', async () => {
  let bound = 0;
  let actual = 2000;
  const commands = [];
  const order = [];
  const h = harness({ read: () => actual, overrides: { applyOffset: (value) => order.push(['sync', value]) } });
  const options = {
    getBoundTop: () => bound,
    setBoundTop: (value) => { bound = value; commands.push(value); },
    nextTick: async () => { order.push(['view-commit']); actual = bound; },
  };
  if (await h.sync.resetToTop(options)) order.push(['refresh']);
  actual = 3000;
  if (await h.sync.resetToTop(options)) order.push(['refresh']);
  assert.deepEqual(commands, [0.1, 0]);
  assert.deepEqual(order, [
    ['view-commit'], ['view-commit'], ['sync', 0.1], ['refresh'],
    ['view-commit'], ['view-commit'], ['sync', 0], ['refresh'],
  ]);
  assert.equal(h.clock.pending.size, 0);
});

test('a changed scroll-top binding alone does not confirm a successful reset', async () => {
  const values = [700, 300, 0.1];
  const h = harness({ read: (index) => values[index - 1] });
  const pending = h.sync.resetToTop({ getBoundTop: () => 0, setBoundTop: () => {}, nextTick: async () => {} });
  await flush();
  assert.deepEqual(h.applied, []);
  await h.clock.advance(20);
  assert.equal(await pending, true);
  assert.deepEqual(h.applied, [0.1]);
});

test('only the latest reset can confirm success after an older query returns', async () => {
  const oldRead = deferred();
  const h = harness({ read: (index) => index === 1 ? oldRead.promise : 0 });
  const options = { getBoundTop: () => 0, setBoundTop: () => {}, nextTick: async () => {} };
  const first = h.sync.resetToTop(options);
  await flush();
  const second = h.sync.resetToTop(options);
  oldRead.resolve(900);
  await flush();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(h.applied, [0]);
  assert.equal(h.clock.pending.size, 0);
});

test('a failed reset does not authorize a data refresh or an adapter position overwrite', async () => {
  const h = harness({ read: () => 500 });
  const pending = h.sync.resetToTop({ getBoundTop: () => 0, setBoundTop: () => {}, nextTick: async () => {} });
  await h.clock.advance(1000);
  let refreshed = false;
  if (await pending) refreshed = true;
  assert.equal(refreshed, false);
  assert.equal(h.reads(), 4);
  assert.match(h.errors[0].message, /did not reach/);
  assert.deepEqual(h.applied, []);
  assert.equal(h.clock.pending.size, 0);
});

test('a missing view commit is bounded and cannot start native queries after timeout', async () => {
  const tick = deferred();
  const h = harness();
  const pending = h.sync.resetToTop({ getBoundTop: () => 0, setBoundTop: () => {}, nextTick: () => tick.promise });
  await h.clock.advance(100);
  assert.equal(await pending, false);
  tick.resolve();
  await flush();
  assert.equal(h.reads(), 0);
  assert.match(h.errors[0].message, /view update timed out/);
});

test('reset-generated scroll events do not cancel an active reset', async () => {
  const waiting = deferred();
  const h = harness({ read: () => waiting.promise });
  const pending = h.sync.resetToTop({ getBoundTop: () => 0, setBoundTop: () => {}, nextTick: async () => {} });
  await flush();
  assert.equal(await h.sync.schedule(), false);
  assert.equal(await h.sync.reconcile(), false);
  waiting.resolve(0);
  assert.equal(await pending, true);
  assert.deepEqual(h.applied, [0]);
});
