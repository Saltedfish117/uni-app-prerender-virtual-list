import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Execute the actual template scripts with synthetic selector-query results.
// This verifies integration order, not browser/native CSS or gesture behavior.
const flush = async () => { for (let index = 0; index < 40; index += 1) await Promise.resolve(); };

async function loadExample(filename) {
  const markdown = await readFile(new URL(`../assets/${filename}`, import.meta.url), 'utf8');
  const component = markdown.match(/```vue\s*\n([\s\S]*?)\n```/)[1];
  const script = component.match(/<script>\s*([\s\S]*?)\s*<\/script>/)[1]
    .replace(/from '\.\/([^']+)'/g, (_, file) => `from '${new URL(`../assets/${file}`, import.meta.url).href}'`);
  return (await import(`data:text/javascript;base64,${Buffer.from(script).toString('base64')}`)).default;
}

async function mountExample(filename) {
  const options = await loadExample(filename);
  let actualTop = 0;
  let lastCommand = 0;
  let view;
  const offsetReads = [];
  let failOffsetReads = false;
  const oldUni = globalThis.uni;
  globalThis.uni = {
    getSystemInfoSync: () => ({ windowHeight: 600 }),
    createSelectorQuery: () => {
      const requests = [];
      const batch = {
        in() { return this; },
        select(selector) {
          return {
            boundingClientRect() { requests.push([selector, 'rect']); return batch; },
            scrollOffset() { requests.push([selector, 'offset']); return batch; },
          };
        },
        selectViewport() { return this.select('viewport'); },
        exec(callback) {
          queueMicrotask(() => callback(requests.map(([selector, kind]) => {
            if (kind === 'offset') {
              offsetReads.push({ actualTop, count: view.sourceNodes?.length });
              return failOffsetReads ? null : { scrollTop: actualTop };
            }
            const height = { '#page-row-sample': 56, '#sample-group': 48, '#sample-compact': 40, '#sample-regular': 64 }[selector];
            if (height) return { width: 320, height };
            if (selector === '#example-scroll') return { width: 320, top: 160, height: 420 };
            return { width: 320, top: (selector === '#page-list' ? 200 : 160) - actualTop };
          })));
        },
      };
      return batch;
    },
  };
  view = {
    ...options.data(),
    $nextTick(callback) {
      queueMicrotask(() => {
        if (view.commandScrollTop !== undefined && view.commandScrollTop !== lastCommand) {
          lastCommand = view.commandScrollTop;
          actualTop = lastCommand;
        }
        callback();
      });
    },
  };
  for (const [key, method] of Object.entries(options.methods)) view[key] = method.bind(view);
  for (const [key, getter] of Object.entries(options.computed)) Object.defineProperty(view, key, { get: () => getter.call(view) });
  options.created.call(view);
  await view.adapter.onShow();
  await view.adapter.onReady();
  await flush();
  return {
    view, offsetReads,
    move(top) {
      actualTop = top;
      if (view.handleContainerScroll) view.handleContainerScroll({ detail: { scrollTop: top } });
      else options.onPageScroll.call(view, { scrollTop: top });
    },
    failReads() { failOffsetReads = true; },
    hide() { options.onHide.call(view); },
    cleanup() { options.onUnload.call(view); globalThis.uni = oldUni; },
  };
}

test('page template publishes bounded keyed content, updates data and appends without resetting scroll', async () => {
  const h = await mountExample('page-scroll-example.md');
  try {
    assert.equal(h.view.layoutReady, true);
    h.move(1800);
    const beforeTop = h.view.adapter.getScrollTop();
    h.view.updateVisibleRow();
    assert.ok(Object.values(h.view.visibleNodes).some((node) => node.data.text.endsWith('已更新')));
    h.view.appendRows();
    assert.equal(h.view.itemCount, 400);
    assert.equal(h.view.adapter.getScrollTop(), beforeTop);
    assert.ok(h.view.visibleKeys.length < 100);
    assert.equal(Object.keys(h.view.visibleNodes).length, h.view.visibleKeys.length);
  } finally { h.cleanup(); }
});

test('container template keeps selected business identities when its visible window moves', async () => {
  const h = await mountExample('scroll-view-example.md');
  try {
    const key = h.view.sourceNodes.find((node) => node.role !== 'group-header').key;
    h.view.toggleRow(key);
    assert.equal(h.view.selectedCount, 1);
    h.move(6000);
    h.move(0);
    h.view.commitSelection();
    const selected = Object.values(h.view.visibleNodes).find((node) => node.key === key);
    assert.equal(selected.selected, true);
    assert.equal(selected.style, `height:${selected.rect.height}px;transform:translateY(${selected.rect.top}px);`);
    assert.equal(Object.keys(h.view.visibleNodes).length, h.view.visibleKeys.length);
  } finally { h.cleanup(); }
});

test('container filter confirms actual near-zero position before replacing data and toggles repeated resets', async () => {
  const h = await mountExample('scroll-view-example.md');
  try {
    h.move(6000);
    const countBefore = h.view.sourceNodes.length;
    const readStart = h.offsetReads.length;
    await h.view.applyFilter(true);
    assert.ok(h.offsetReads.slice(readStart).some((read) => read.actualTop <= 1 && read.count === countBefore));
    assert.equal(h.view.commandScrollTop, 0.1);
    assert.equal(h.view.adapter.getScrollTop(), 0.1);
    assert.ok(h.view.sourceNodes.length < countBefore);
    assert.ok(h.view.sourceNodes.every((node) => node.role === 'group-header' || node.data.sequence % 2 === 0));
    assert.equal(h.view.filterPending, false);
    h.move(3000);
    await h.view.applyFilter(false);
    assert.equal(h.view.commandScrollTop, 0);
    assert.equal(h.view.sourceNodes.length, countBefore);
    assert.equal(h.view.adapter.getScrollTop(), 0);
  } finally { h.cleanup(); }
});

test('rapid filter confirmations only apply the latest template operation', async () => {
  const h = await mountExample('scroll-view-example.md');
  try {
    h.move(5000);
    const countBefore = h.view.sourceNodes.length;
    const first = h.view.applyFilter(true);
    const second = h.view.applyFilter(false);
    await Promise.all([first, second]);
    assert.equal(h.view.sourceNodes.length, countBefore);
    assert.equal(h.view.filterVersion, 2);
    assert.equal(h.view.filterPending, false);
    assert.equal(h.view.commandScrollTop, 0.1);
    assert.equal(h.view.adapter.getScrollTop(), 0.1);
  } finally { h.cleanup(); }
});

test('hiding during a pending filter view commit cancels data replacement', async () => {
  const h = await mountExample('scroll-view-example.md');
  try {
    const callbacks = [];
    h.view.$nextTick = (callback) => callbacks.push(callback);
    const originalNodes = h.view.sourceNodes;
    const pending = h.view.applyFilter(true);
    await flush();
    h.hide();
    callbacks.forEach((callback) => callback());
    await pending;
    assert.equal(h.view.sourceNodes, originalNodes);
    assert.equal(h.view.filterPending, false);
    assert.equal(h.view.adapter.isActive(), false);
  } finally { h.cleanup(); }
});

test('failed actual-offset reads preserve existing template data and expose a retry message', async () => {
  const h = await mountExample('scroll-view-example.md');
  try {
    h.failReads();
    const originalNodes = h.view.sourceNodes;
    await h.view.applyFilter(true);
    assert.equal(h.view.sourceNodes, originalNodes);
    assert.equal(h.view.filterPending, false);
    assert.ok(h.view.layoutError.length > 0);
  } finally { h.cleanup(); }
});
