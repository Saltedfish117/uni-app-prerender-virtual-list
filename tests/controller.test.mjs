import test from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualListController } from '../assets/virtual-list-controller.js';

// Every label, identifier and record in this suite is synthetic test data.

// Keep this oracle intentionally linear and separate from the controller's
// search strategy. It models only public geometry and interval semantics.
function linearLayout(nodes, metrics, mode) {
  let bottom = 0;
  return nodes.map((node, index) => {
    const top = bottom + (mode === 'typed' ? (node.gapBefore ?? 0) : 0);
    const height = mode === 'fixed' ? metrics.rowHeight : metrics.heightByType[node.type];
    bottom = top + height;
    return { ...node, index, rect: { top, height, bottom } };
  });
}

function linearWindow(nodes, metrics, mode, localTop, bufferScreens) {
  const layout = linearLayout(nodes, metrics, mode);
  const buffer = metrics.viewportHeight * bufferScreens;
  const lower = localTop - buffer;
  const upper = localTop + metrics.viewportHeight + buffer;
  let start = 0;
  while (start < layout.length && layout[start].rect.bottom <= lower) start += 1;
  let endExclusive = start;
  while (endExclusive < layout.length && layout[endExclusive].rect.top < upper) endExclusive += 1;
  return {
    start,
    endExclusive,
    totalHeight: layout.at(-1)?.rect.bottom ?? 0,
    visible: layout.slice(start, endExclusive),
    layout,
  };
}

function assertWindow(snapshot, nodes, metrics, mode, localTop, bufferScreens = 3) {
  const expected = linearWindow(nodes, metrics, mode, localTop, bufferScreens);
  assert.equal(snapshot.totalHeight, expected.totalHeight, 'total height');
  assert.equal(snapshot.start, expected.start, 'first visible index');
  assert.equal(snapshot.endExclusive, expected.endExclusive, 'exclusive end index');
  assert.deepEqual(
    snapshot.visibleList.map(({ key, index, rect }) => ({ key, index, rect })),
    expected.visible.map(({ key, index, rect }) => ({ key, index, rect })),
    `window at localTop=${localTop}`,
  );
  for (const item of snapshot.visibleList) {
    assert.equal(item.data, nodes[item.index].data, 'retain the supplied data reference');
  }
  return expected;
}

function assertGroups(snapshot, nodes, metrics, localTop) {
  const headers = linearLayout(nodes, metrics, 'typed').filter((node) => node.role === 'group-header');
  const activationTop = localTop + metrics.topInset;
  let active = null;
  for (const header of headers) {
    if (header.rect.top <= activationTop) active = header;
  }
  const stickyVisible = active !== null && activationTop >= headers[0].rect.bottom;
  assert.equal(snapshot.activeGroupId, active?.groupId ?? null, 'active group follows its header top');
  assert.equal(snapshot.stickyVisible, stickyVisible, 'sticky starts after the first header bottom');
  if (stickyVisible) {
    assert.deepEqual(snapshot.stickyGroup, {
      key: active.key,
      groupId: active.groupId,
      data: active.data,
      top: active.rect.top,
      bottom: active.rect.bottom,
      index: active.index,
    });
  } else {
    assert.equal(snapshot.stickyGroup, null);
  }
}

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.pending = new Map();
  }

  now() {
    return this.time;
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.pending.set(id, { callback, due: this.time + Math.max(0, delay) });
    return id;
  }

  clearTimeout(id) {
    this.pending.delete(id);
  }

  advance(milliseconds) {
    const target = this.time + milliseconds;
    let executions = 0;
    while (true) {
      let next = null;
      for (const [id, timer] of this.pending) {
        if (timer.due <= target && (!next || timer.due < next.timer.due || (timer.due === next.timer.due && id < next.id))) {
          next = { id, timer };
        }
      }
      if (!next) break;
      assert.ok(++executions < 1000, 'timer callbacks must converge');
      this.time = next.timer.due;
      this.pending.delete(next.id);
      next.timer.callback();
    }
    this.time = target;
  }
}

function fixedNodes(count) {
  return Array.from({ length: count }, (_, index) => ({
    key: index,
    data: { label: `Item ${index}`, selected: false },
  }));
}

function groupedNodes() {
  return [
    { key: 'header-a', type: 'header', role: 'group-header', groupId: 0, data: { label: 'Alpha' }, gapBefore: 40 },
    { key: 'item-a', type: 'item', data: { label: 'One' }, gapBefore: 5 },
    { key: 'header-b', type: 'header', role: 'group-header', groupId: 1, data: { label: 'Beta' }, gapBefore: 15 },
    { key: 'item-b', type: 'item', data: { label: 'Two' } },
    { key: 'header-c', type: 'header', role: 'group-header', groupId: '1', data: { label: 'Gamma' }, gapBefore: 25 },
    { key: 'item-c', type: 'item', data: { label: 'Three' } },
  ];
}

const fixedMetrics = { rowHeight: 10, viewportHeight: 100, topInset: 0 };
const typedMetrics = { heightByType: { header: 20, item: 40 }, viewportHeight: 30, topInset: 10 };

function setup(options = {}) {
  const updates = [];
  const clock = new FakeClock();
  const controller = createVirtualListController({
    mode: 'fixed',
    clock,
    onUpdate: (snapshot) => updates.push(snapshot),
    ...options,
  });
  return { controller, updates, clock };
}

test('empty keys cannot replace a valid published layout', () => {
  const { controller, updates } = setup();
  controller.replaceLayout(fixedNodes(20), fixedMetrics, 0);
  const previous = controller.getSnapshot();
  assert.throws(() => controller.replaceLayout([{ key: '', data: { label: 'Synthetic empty key' } }], fixedMetrics, 0));
  assert.equal(controller.getSnapshot().visibleList, previous.visibleList);
  assert.equal(controller.getSnapshot().layoutVersion, previous.layoutVersion);
  assert.equal(updates.length, 1);
  controller.destroy();
});

test('a clock rollback cancels stale timers and immediately uses the latest position', () => {
  const { controller, updates, clock } = setup();
  const nodes = fixedNodes(1000);
  clock.time = 1000;
  controller.replaceLayout(nodes, fixedMetrics, 2000);
  clock.time = 1010;
  controller.handleScroll(2020);
  assert.equal(clock.pending.size, 1);
  assert.equal(updates.length, 1);
  clock.time = 900;
  controller.handleScroll(2040);
  assert.equal(clock.pending.size, 0);
  assert.equal(updates.length, 2);
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', 2040);
  clock.advance(1000);
  assert.equal(updates.length, 2);
  controller.destroy();
});

test('empty and single-item layouts obey half-open interval boundaries', () => {
  const { controller, updates } = setup({ bufferScreens: 0 });
  controller.replaceLayout([], fixedMetrics, 0);
  assert.equal(updates.length, 1);
  assertWindow(controller.getSnapshot(), [], fixedMetrics, 'fixed', 0, 0);
  const nodes = fixedNodes(1);
  controller.replaceLayout(nodes, fixedMetrics, 0);
  assert.equal(updates.length, 2, 'replaceLayout publishes exactly once');
  for (const position of [-101, -100, -99, -1, 0, 9, 10, 11, 1000]) {
    controller.refresh(position);
    assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', position, 0);
  }
  controller.destroy();
});

test('negative local positions do not pin offscreen content into the window', () => {
  const nodes = fixedNodes(30);
  const { controller } = setup();
  controller.replaceLayout(nodes, fixedMetrics, -500);
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', -500);
  assert.deepEqual(controller.getSnapshot().visibleList, []);
  controller.refresh(-399);
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', -399);
  assert.deepEqual(controller.getSnapshot().visibleList.map((node) => node.key), [0]);
  controller.destroy();
});

test('the default three-screen buffer matches a linear oracle for a large fixed list', () => {
  const nodes = fixedNodes(5007);
  const metrics = { rowHeight: 37, viewportHeight: 211, topInset: 19 };
  const { controller } = setup();
  controller.replaceLayout(nodes, metrics, 0);
  const total = nodes.length * metrics.rowHeight;
  const positions = [-2000, -844, -843, -842, -1, 0, 1, 37, total - 211, total, total + 633, total + 1000];
  for (let index = 0; index <= 70; index += 1) positions.push(Math.floor((total * index) / 70));
  for (const position of positions) {
    controller.refresh(position);
    assertWindow(controller.getSnapshot(), nodes, metrics, 'fixed', position);
  }
  assert.equal(nodes.length, 5007, 'virtualization does not trim the data source');
  controller.destroy();
});

test('typed rows include leading and inter-row gaps without rendering touching boundaries', () => {
  const nodes = [
    { key: 'a', type: 'short', gapBefore: 100, data: { label: 'A' } },
    { key: 'b', type: 'tall', gapBefore: 50, data: { label: 'B' } },
    { key: 'c', type: 'short', gapBefore: 0, data: { label: 'C' } },
  ];
  const metrics = { heightByType: { short: 20, tall: 70 }, viewportHeight: 10, topInset: 0 };
  const { controller } = setup({ mode: 'typed', bufferScreens: 0 });
  controller.replaceLayout(nodes, metrics, 0);
  for (const position of [-100, 0, 90, 91, 100, 119, 120, 159, 160, 161, 170, 239, 240, 259, 260, 1000]) {
    controller.refresh(position);
    assertWindow(controller.getSnapshot(), nodes, metrics, 'typed', position, 0);
  }
  assert.equal(controller.getSnapshot().totalHeight, 260);
  controller.destroy();
});

test('mixed-height layouts with more than 5000 nodes match the independent oracle', () => {
  const nodes = Array.from({ length: 5503 }, (_, index) => ({
    key: `row-${index}`,
    type: index % 13 === 0 ? 'header' : index % 3 === 0 ? 'tall' : 'item',
    ...(index % 13 === 0 ? { role: 'group-header', groupId: index / 13 } : {}),
    gapBefore: index % 7 === 0 ? 9 : 0,
    data: { label: `Row ${index}` },
  }));
  const metrics = { heightByType: { header: 23, tall: 97, item: 41 }, viewportHeight: 223, topInset: 12 };
  const { controller } = setup({ mode: 'typed', bufferScreens: 1.5 });
  const total = linearLayout(nodes, metrics, 'typed').at(-1).rect.bottom;
  controller.replaceLayout(nodes, metrics, -1000);
  const positions = [-1000, -1, 0, total - metrics.viewportHeight, total, total + 1000];
  for (let index = 0; index < 65; index += 1) positions.push((total * index) / 64);
  for (const position of positions) {
    controller.refresh(position);
    assertWindow(controller.getSnapshot(), nodes, metrics, 'typed', position, 1.5);
    assertGroups(controller.getSnapshot(), nodes, metrics, position);
  }
  controller.destroy();
});

test('geometry-only metric changes preserve layout identity while height changes rebuild it', () => {
  const nodes = fixedNodes(100);
  const metrics = { rowHeight: 20, viewportHeight: 51, topInset: 0 };
  const { controller } = setup({ bufferScreens: 0 });
  controller.replaceLayout(nodes, metrics, 5);
  const original = controller.getSnapshot();
  controller.setMetrics({ viewportHeight: 52, topInset: 7 }, 5);
  const geometry = controller.getSnapshot();
  assert.equal(geometry.layoutVersion, original.layoutVersion);
  assert.equal(geometry.visibleList, original.visibleList, 'same index window reuses the rendered array');
  assertWindow(geometry, nodes, { ...metrics, viewportHeight: 52, topInset: 7 }, 'fixed', 5, 0);
  controller.setMetrics({ rowHeight: 25 }, 5);
  const resized = controller.getSnapshot();
  assert.ok(resized.layoutVersion > original.layoutVersion);
  assert.notEqual(resized.visibleList, geometry.visibleList);
  assertWindow(resized, nodes, { rowHeight: 25, viewportHeight: 52, topInset: 7 }, 'fixed', 5, 0);
  controller.destroy();
});

test('typed height inputs cannot silently invalidate geometry through external mutation', () => {
  const nodes = groupedNodes();
  const heightByType = { header: 20, item: 40 };
  const metrics = { ...typedMetrics, heightByType };
  const { controller } = setup({ mode: 'typed' });
  controller.replaceLayout(nodes, metrics, 50);
  const oldVersion = controller.getSnapshot().layoutVersion;
  heightByType.item = 80;
  controller.refresh(50, { force: true });
  assertWindow(controller.getSnapshot(), nodes, typedMetrics, 'typed', 50);
  controller.setMetrics({ heightByType }, 50);
  assert.ok(controller.getSnapshot().layoutVersion > oldVersion);
  assertWindow(controller.getSnapshot(), nodes, metrics, 'typed', 50);
  heightByType.item = 120;
  controller.refresh(50, { force: true });
  assertWindow(controller.getSnapshot(), nodes, { ...metrics, heightByType: { header: 20, item: 80 } }, 'typed', 50);
  controller.destroy();
});

test('same-window refresh reuses the array, while force and layout replacement republish data', () => {
  const nodes = fixedNodes(100);
  const metrics = { rowHeight: 20, viewportHeight: 51, topInset: 0 };
  const { controller, updates } = setup({ bufferScreens: 0 });
  controller.replaceLayout(nodes, metrics, 5);
  const initial = controller.getSnapshot();
  controller.refresh(6);
  const same = controller.getSnapshot();
  assert.equal(same.visibleList, initial.visibleList);
  assert.equal(same.visibleChanged, false);
  nodes[1].data.selected = true;
  controller.refresh(6, { force: true });
  const forced = controller.getSnapshot();
  assert.notEqual(forced.visibleList, same.visibleList);
  assert.equal(forced.visibleChanged, true);
  assert.equal(forced.visibleList[1].data.selected, true);
  assert.equal(forced.layoutVersion, initial.layoutVersion);
  const replacement = nodes.map((node) => ({ ...node, data: { ...node.data, label: `Changed ${node.key}` } }));
  const beforeCount = updates.length;
  controller.replaceLayout(replacement, metrics, 6);
  const replaced = controller.getSnapshot();
  assert.equal(updates.length, beforeCount + 1);
  assert.ok(replaced.layoutVersion > forced.layoutVersion);
  assert.notEqual(replaced.visibleList, forced.visibleList);
  assert.equal(replaced.visibleList[1].data.label, 'Changed 1');
  assertWindow(replaced, replacement, metrics, 'fixed', 6, 0);
  controller.destroy();
});

test('invalid fixed layouts are rejected atomically before any publication', () => {
  const nodes = fixedNodes(20);
  const { controller, updates } = setup();
  controller.replaceLayout(nodes, fixedMetrics, 20);
  const before = controller.getSnapshot();
  const updateCount = updates.length;
  const invalidCases = [
    [null, fixedMetrics],
    [[{ key: 1, data: {} }, { key: 1, data: {} }], fixedMetrics],
    [[{ key: null, data: {} }], fixedMetrics],
    [[{ key: {}, data: {} }], fixedMetrics],
    [[{ key: 'a', data: {}, gapBefore: 1 }], fixedMetrics],
    [[{ key: 'h', data: {}, role: 'group-header', groupId: 'a' }], fixedMetrics],
    [nodes, { ...fixedMetrics, rowHeight: 0 }],
    [nodes, { ...fixedMetrics, rowHeight: -1 }],
    [nodes, { ...fixedMetrics, rowHeight: Number.NaN }],
    [nodes, { ...fixedMetrics, rowHeight: Number.POSITIVE_INFINITY }],
    [nodes, { ...fixedMetrics, viewportHeight: 0 }],
    [nodes, { ...fixedMetrics, topInset: -1 }],
  ];
  for (const [invalidNodes, invalidMetrics] of invalidCases) {
    assert.throws(() => controller.replaceLayout(invalidNodes, invalidMetrics, 0));
    const after = controller.getSnapshot();
    assert.equal(updates.length, updateCount);
    assert.equal(after.layoutVersion, before.layoutVersion);
    assert.equal(after.visibleList, before.visibleList);
    assertWindow(after, nodes, fixedMetrics, 'fixed', 20);
  }
  controller.destroy();
});

test('invalid typed rows and metric updates cannot partially change the current layout', () => {
  const nodes = groupedNodes();
  const { controller, updates } = setup({ mode: 'typed' });
  controller.replaceLayout(nodes, typedMetrics, 80);
  const before = controller.getSnapshot();
  const updateCount = updates.length;
  const invalidNodes = [
    [{ key: 'a', type: 'missing', data: {} }],
    [{ key: 'a', type: 'item', data: {}, gapBefore: -1 }],
    [{ key: 'a', type: 'item', data: {}, gapBefore: Number.NaN }],
    [{ key: 'a', type: 'header', data: {}, role: 'group-header' }],
    [{ key: 'a', type: 'header', data: {}, role: 'group-header', groupId: '' }],
    [
      { key: 'a', type: 'header', data: {}, role: 'group-header', groupId: 'same' },
      { key: 'b', type: 'header', data: {}, role: 'group-header', groupId: 'same' },
    ],
  ];
  for (const invalid of invalidNodes) {
    assert.throws(() => controller.replaceLayout(invalid, typedMetrics, 0));
    assert.equal(updates.length, updateCount);
    assert.equal(controller.getSnapshot().visibleList, before.visibleList);
    assert.equal(controller.getSnapshot().layoutVersion, before.layoutVersion);
  }
  for (const invalid of [
    { viewportHeight: Number.NaN },
    { topInset: -1 },
    { heightByType: { header: 20, item: 0 } },
    { heightByType: { header: 20 } },
  ]) {
    assert.throws(() => controller.setMetrics(invalid, 0));
    assert.equal(updates.length, updateCount);
    assert.equal(controller.getSnapshot().visibleList, before.visibleList);
    assert.equal(controller.getSnapshot().layoutVersion, before.layoutVersion);
    assertWindow(controller.getSnapshot(), nodes, typedMetrics, 'typed', 80);
  }
  controller.destroy();
});

test('numeric and string keys remain distinct without string coercion', () => {
  const nodes = [{ key: 1, data: { label: 'Numeric' } }, { key: '1', data: { label: 'String' } }];
  const { controller } = setup();
  controller.replaceLayout(nodes, fixedMetrics, 0);
  assert.deepEqual(controller.getSnapshot().visibleList.map(({ key }) => key), [1, '1']);
  controller.destroy();
});

test('scroll throttling delivers the latest position on the trailing tick', () => {
  const nodes = fixedNodes(1000);
  const { controller, updates, clock } = setup();
  controller.replaceLayout(nodes, fixedMetrics, 1000);
  clock.advance(150);
  controller.handleScroll(1010);
  const beforeBurst = updates.length;
  controller.handleScroll(1020);
  clock.advance(50);
  controller.handleScroll(1050);
  clock.advance(99);
  assert.equal(updates.length, beforeBurst, 'no intermediate publication inside the throttle interval');
  clock.advance(1);
  assert.equal(updates.length, beforeBurst + 1, 'one trailing publication');
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', 1050);
  clock.advance(1000);
  assert.equal(updates.length, beforeBurst + 1, 'no duplicate trailing callbacks');
  controller.destroy();
});

test('rapid direction changes retain the latest scroll value in the pending update', () => {
  const nodes = fixedNodes(1000);
  const { controller, updates, clock } = setup({ throttleMs: 120 });
  controller.replaceLayout(nodes, fixedMetrics, 1000);
  clock.advance(120);
  controller.handleScroll(1010);
  const beforeBurst = updates.length;
  controller.handleScroll(1040);
  clock.advance(30);
  controller.handleScroll(990);
  clock.advance(89);
  assert.equal(updates.length, beforeBurst);
  clock.advance(1);
  assert.equal(updates.length, beforeBurst + 1);
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', 990);
  controller.destroy();
});

test('approaching the directional edge or jumping outside the old window updates immediately', () => {
  const nodes = fixedNodes(1000);
  const { controller, updates, clock } = setup();
  controller.replaceLayout(nodes, fixedMetrics, 1000);
  let before = updates.length;
  controller.handleScroll(1210);
  assert.equal(updates.length, before + 1, 'less than one viewport remains below');
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', 1210);
  before = updates.length;
  controller.handleScroll(4000);
  assert.equal(updates.length, before + 1, 'a large forward jump cannot wait for throttling');
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', 4000);
  before = updates.length;
  controller.handleScroll(3780);
  assert.equal(updates.length, before + 1, 'reverse direction checks the upper edge');
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', 3780);
  clock.advance(1000);
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', 3780);
  controller.destroy();
});

test('an immediate edge update supersedes an older pending scroll', () => {
  const nodes = fixedNodes(1000);
  const { controller, updates, clock } = setup();
  controller.replaceLayout(nodes, fixedMetrics, 1000);
  clock.advance(150);
  controller.handleScroll(1010);
  controller.handleScroll(1020);
  assert.ok(clock.pending.size > 0);
  controller.handleScroll(4000);
  const afterJump = updates.length;
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', 4000);
  clock.advance(1000);
  assert.equal(updates.length, afterJump, 'stale scheduled work must be cancelled');
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', 4000);
  controller.destroy();
});

test('group activation, sticky state, and anchor offsets preserve identifier types', () => {
  const nodes = groupedNodes();
  const { controller } = setup({ mode: 'typed', bufferScreens: 0 });
  controller.replaceLayout(nodes, typedMetrics, -100);
  const layout = linearLayout(nodes, typedMetrics, 'typed');
  for (const header of layout.filter((node) => node.role === 'group-header')) {
    assert.equal(controller.getGroupOffset(header.groupId), header.rect.top - typedMetrics.topInset);
  }
  assert.equal(controller.getGroupOffset('0'), null);
  assert.equal(controller.getGroupOffset('unknown'), null);
  assert.notEqual(controller.getGroupOffset(1), controller.getGroupOffset('1'));
  for (const position of [-100, 29, 30, 49, 50, 109, 110, 129, 195, 196, 215, 1000]) {
    controller.refresh(position);
    assertWindow(controller.getSnapshot(), nodes, typedMetrics, 'typed', position, 0);
    assertGroups(controller.getSnapshot(), nodes, typedMetrics, position);
  }
  controller.refresh(31);
  assert.equal(controller.getSnapshot().activeChanged, true);
  const current = controller.getSnapshot().visibleList;
  controller.refresh(32);
  assert.equal(controller.getSnapshot().activeChanged, false);
  assert.equal(controller.getSnapshot().visibleList, current);
  controller.destroy();
});

test('programmatic group selection locks activation while the rendered window keeps moving', () => {
  const nodes = groupedNodes();
  const { controller } = setup({ mode: 'typed', bufferScreens: 0, throttleMs: 0 });
  controller.replaceLayout(nodes, typedMetrics, 80);
  controller.beginProgrammaticScroll('1');
  assert.equal(controller.getSnapshot().activeGroupId, '1');
  for (const position of [110, 150, 195]) {
    controller.handleScroll(position);
    assert.equal(controller.getSnapshot().activeGroupId, '1');
    assertWindow(controller.getSnapshot(), nodes, typedMetrics, 'typed', position, 0);
  }
  controller.endProgrammaticScroll(80);
  assertWindow(controller.getSnapshot(), nodes, typedMetrics, 'typed', 80, 0);
  assertGroups(controller.getSnapshot(), nodes, typedMetrics, 80);
  assert.equal(controller.getSnapshot().activeGroupId, 0, 'completion uses the actual final position');
  controller.destroy();
});

test('pause cancels pending work, suppresses publication, and resume recomputes the requested position', () => {
  const nodes = fixedNodes(1000);
  const { controller, updates, clock } = setup();
  controller.replaceLayout(nodes, fixedMetrics, 1000);
  clock.advance(150);
  controller.handleScroll(1010);
  controller.handleScroll(1020);
  assert.ok(clock.pending.size > 0);
  const beforePause = updates.length;
  controller.pause();
  assert.equal(clock.pending.size, 0, 'pause clears its timer');
  controller.handleScroll(1300);
  controller.refresh(1400, { force: true });
  clock.advance(1000);
  assert.equal(updates.length, beforePause);
  controller.resume(1500);
  assert.equal(updates.length, beforePause + 1);
  assertWindow(controller.getSnapshot(), nodes, fixedMetrics, 'fixed', 1500);
  controller.destroy();
});

test('destroy is idempotent and prevents delayed or resumed publications', () => {
  const nodes = fixedNodes(1000);
  const { controller, updates, clock } = setup();
  controller.replaceLayout(nodes, fixedMetrics, 1000);
  clock.advance(150);
  controller.handleScroll(1010);
  controller.handleScroll(1020);
  assert.ok(clock.pending.size > 0);
  const beforeDestroy = updates.length;
  controller.destroy();
  controller.destroy();
  assert.equal(clock.pending.size, 0);
  controller.handleScroll(3000);
  controller.refresh(3000, { force: true });
  controller.resume(3000);
  clock.advance(10000);
  assert.equal(updates.length, beforeDestroy);
});
