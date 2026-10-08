/**
 * A platform-independent virtual list controller.
 *
 * All dimensions use pixels. scrollTop is relative to the list's origin and may
 * be negative while content above the list occupies the viewport. topInset
 * affects group activation and jump targets, not viewportHeight.
 *
 * Treat snapshots and their display data as read-only. This module does not
 * measure elements, fetch records, or mutate the supplied nodes and height map.
 */

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function finiteNumber(value, name, minimum = -Infinity, exclusive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  if (exclusive ? value <= minimum : value < minimum) {
    throw new RangeError(`${name} must be ${exclusive ? 'greater than' : 'at least'} ${minimum}`);
  }
  return value;
}

function isIdentifier(value) {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isFinite(value));
}

function emptySnapshot(layoutVersion = 0) {
  return {
    visibleList: [],
    totalHeight: 0,
    start: 0,
    endExclusive: 0,
    layoutVersion,
    visibleChanged: false,
    activeGroupId: null,
    activeChanged: false,
    stickyVisible: false,
    stickyGroup: null,
  };
}

/**
 * @param {Object} options
 * @param {'fixed'|'typed'} options.mode
 * @param {number} [options.bufferScreens=3]
 * @param {number} [options.throttleMs=150]
 * @param {(snapshot: Object) => void} [options.onUpdate]
 * @param {{now: Function, setTimeout: Function, clearTimeout: Function}} [options.clock]
 */
export function createVirtualListController({
  mode,
  bufferScreens = 3,
  throttleMs = 150,
  onUpdate,
  clock,
} = {}) {
  if (mode !== 'fixed' && mode !== 'typed') {
    throw new TypeError('mode must be fixed or typed');
  }
  finiteNumber(bufferScreens, 'bufferScreens', 0);
  finiteNumber(throttleMs, 'throttleMs', 0);
  if (onUpdate !== undefined && typeof onUpdate !== 'function') {
    throw new TypeError('onUpdate must be a function');
  }

  const timerClock = clock ?? {
    now: typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now.bind(performance)
      : () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
  for (const method of ['now', 'setTimeout', 'clearTimeout']) {
    if (typeof timerClock[method] !== 'function') {
      throw new TypeError(`clock.${method} must be a function`);
    }
  }
  const now = timerClock.now.bind(timerClock);
  const schedule = timerClock.setTimeout.bind(timerClock);
  const unschedule = timerClock.clearTimeout.bind(timerClock);

  let callback = onUpdate ?? null;
  let nodes = [];
  let layoutNodes = [];
  let anchors = [];
  let anchorById = new Map();
  let metrics = null;
  let totalHeight = 0;
  let layoutVersion = 0;
  let snapshot = emptySnapshot();
  let currentScrollTop = 0;
  let latestScrollTop = 0;
  let lastRawScrollTop = 0;
  let lastRunAt = -Infinity;
  let timer = null;
  let lockedGroupId = null;
  let paused = false;
  let destroyed = false;

  const copySnapshot = () => ({ ...snapshot });

  function cancelTimer() {
    if (timer !== null) unschedule(timer);
    timer = null;
  }

  function readMetrics(nextMetrics) {
    if (!nextMetrics || typeof nextMetrics !== 'object' || Array.isArray(nextMetrics)) {
      throw new TypeError('metrics must be an object');
    }
    const next = {
      viewportHeight: hasOwn(nextMetrics, 'viewportHeight')
        ? nextMetrics.viewportHeight
        : metrics?.viewportHeight,
      topInset: hasOwn(nextMetrics, 'topInset') ? nextMetrics.topInset : (metrics?.topInset ?? 0),
    };
    finiteNumber(next.viewportHeight, 'viewportHeight', 0, true);
    finiteNumber(next.topInset, 'topInset', 0);
    finiteNumber(next.viewportHeight * bufferScreens, 'buffer height', 0);

    if (mode === 'fixed') {
      next.rowHeight = hasOwn(nextMetrics, 'rowHeight') ? nextMetrics.rowHeight : metrics?.rowHeight;
      finiteNumber(next.rowHeight, 'rowHeight', 0, true);
    } else {
      const heights = hasOwn(nextMetrics, 'heightByType')
        ? nextMetrics.heightByType
        : metrics?.heightByType;
      if (!heights || typeof heights !== 'object' || Array.isArray(heights)) {
        throw new TypeError('heightByType must be an object or Map');
      }
      next.heightByType = new Map();
      const entries = heights instanceof Map ? heights.entries() : Object.entries(heights);
      for (const [type, height] of entries) {
        if (typeof type !== 'string' || type.length === 0) {
          throw new TypeError('heightByType keys must be nonempty strings');
        }
        next.heightByType.set(type, finiteNumber(height, `heightByType[${type}]`, 0, true));
      }
    }
    return next;
  }

  // Build a complete candidate without changing any live state.
  function buildLayout(inputNodes, nextMetrics) {
    if (!Array.isArray(inputNodes)) throw new TypeError('nodes must be an array');
    const candidateNodes = [];
    const candidateLayout = [];
    const candidateAnchors = [];
    const candidateAnchorById = new Map();
    const keys = new Set();
    let cursor = 0;

    inputNodes.forEach((inputNode, index) => {
      if (!inputNode || typeof inputNode !== 'object' || Array.isArray(inputNode)) {
        throw new TypeError(`nodes[${index}] must be an object`);
      }
      if (!isIdentifier(inputNode.key)) throw new TypeError(`nodes[${index}].key must be a nonempty string or finite number`);
      if (keys.has(inputNode.key)) throw new Error(`duplicate node key at index ${index}`);
      keys.add(inputNode.key);
      if (inputNode.role !== undefined && inputNode.role !== 'group-header') {
        throw new TypeError(`nodes[${index}].role must be group-header when present`);
      }
      const gapBefore = inputNode.gapBefore === undefined ? 0 : inputNode.gapBefore;
      finiteNumber(gapBefore, `nodes[${index}].gapBefore`, 0);
      const node = { ...inputNode };
      candidateNodes.push(node);

      if (mode === 'fixed') {
        if (node.role !== undefined || node.groupId !== undefined || gapBefore !== 0) {
          throw new Error('fixed mode does not support groups or gaps');
        }
        return;
      }
      if (typeof node.type !== 'string' || node.type.length === 0) {
        throw new TypeError(`nodes[${index}].type must be a nonempty string`);
      }
      const height = nextMetrics.heightByType.get(node.type);
      finiteNumber(height, `height for nodes[${index}].type`, 0, true);
      const top = finiteNumber(cursor + gapBefore, 'node top', 0);
      const bottom = finiteNumber(top + height, 'node bottom', 0);
      candidateLayout.push({ ...node, index, rect: { top, height, bottom } });
      if (node.role === 'group-header') {
        if (!isIdentifier(node.groupId)) {
          throw new TypeError(`nodes[${index}].groupId must be a nonempty string or finite number`);
        }
        if (candidateAnchorById.has(node.groupId)) throw new Error(`duplicate groupId at index ${index}`);
        const anchor = { key: node.key, groupId: node.groupId, data: node.data, top, bottom, index };
        candidateAnchors.push(anchor);
        candidateAnchorById.set(node.groupId, anchor);
      }
      cursor = bottom;
    });

    return {
      nodes: candidateNodes,
      layoutNodes: candidateLayout,
      anchors: candidateAnchors,
      anchorById: candidateAnchorById,
      totalHeight: mode === 'fixed'
        ? finiteNumber(candidateNodes.length * nextMetrics.rowHeight, 'totalHeight', 0)
        : cursor,
    };
  }

  function commitLayout(candidate, nextMetrics) {
    nodes = candidate.nodes;
    layoutNodes = candidate.layoutNodes;
    anchors = candidate.anchors;
    anchorById = candidate.anchorById;
    totalHeight = candidate.totalHeight;
    metrics = nextMetrics;
    layoutVersion += 1;
    if (lockedGroupId !== null && !anchorById.has(lockedGroupId)) lockedGroupId = null;
  }

  function lowerBound(items, predicate) {
    let left = 0;
    let right = items.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (predicate(items[middle])) right = middle;
      else left = middle + 1;
    }
    return left;
  }

  function findWindow(scrollTop) {
    const buffer = metrics.viewportHeight * bufferScreens;
    const windowTop = scrollTop - buffer;
    const windowBottom = scrollTop + metrics.viewportHeight + buffer;
    if (mode === 'fixed') {
      const clampIndex = (value) => Math.max(0, Math.min(nodes.length, value));
      return {
        start: clampIndex(Math.floor(windowTop / metrics.rowHeight)),
        endExclusive: clampIndex(Math.ceil(windowBottom / metrics.rowHeight)),
      };
    }
    return {
      start: lowerBound(layoutNodes, (node) => node.rect.bottom > windowTop),
      endExclusive: lowerBound(layoutNodes, (node) => node.rect.top >= windowBottom),
    };
  }

  function groupState(scrollTop) {
    const activationTop = scrollTop + metrics.topInset;
    const afterActive = lowerBound(anchors, (anchor) => anchor.top > activationTop);
    const naturalAnchor = afterActive > 0 ? anchors[afterActive - 1] : null;
    const activeAnchor = lockedGroupId === null ? naturalAnchor : anchorById.get(lockedGroupId);
    const stickyVisible = Boolean(activeAnchor && anchors.length && activationTop >= anchors[0].bottom);
    return {
      activeGroupId: activeAnchor?.groupId ?? null,
      stickyVisible,
      stickyGroup: stickyVisible ? activeAnchor : null,
    };
  }

  function calculate(scrollTop, force = false) {
    const { start, endExclusive } = findWindow(scrollTop);
    const visibleChanged = force || snapshot.layoutVersion !== layoutVersion
      || snapshot.start !== start || snapshot.endExclusive !== endExclusive;
    let visibleList = snapshot.visibleList;
    if (visibleChanged) {
      visibleList = mode === 'typed'
        ? layoutNodes.slice(start, endExclusive)
        : nodes.slice(start, endExclusive).map((node, offset) => {
          const index = start + offset;
          const top = index * metrics.rowHeight;
          return { ...node, index, rect: { top, height: metrics.rowHeight, bottom: top + metrics.rowHeight } };
        });
    }
    const nextGroup = groupState(scrollTop);
    return {
      visibleList,
      totalHeight,
      start,
      endExclusive,
      layoutVersion,
      visibleChanged,
      ...nextGroup,
      activeChanged: snapshot.activeGroupId !== nextGroup.activeGroupId,
    };
  }

  function runUpdate(scrollTop, force = false) {
    currentScrollTop = scrollTop;
    if (!metrics || destroyed) return copySnapshot();
    const previous = snapshot;
    const next = calculate(scrollTop, force);
    const changed = next.visibleChanged || next.activeChanged
      || next.stickyVisible !== previous.stickyVisible || next.stickyGroup !== previous.stickyGroup;
    snapshot = next;
    if (!paused) {
      lastRunAt = now();
      if (changed && callback) callback(copySnapshot());
    }
    return copySnapshot();
  }

  function refresh(scrollTop = currentScrollTop, { force = false } = {}) {
    if (destroyed) return copySnapshot();
    finiteNumber(scrollTop, 'scrollTop');
    cancelTimer();
    latestScrollTop = scrollTop;
    lastRawScrollTop = scrollTop;
    return runUpdate(scrollTop, Boolean(force));
  }

  function replaceLayout(inputNodes, nextMetrics, scrollTop = currentScrollTop) {
    if (destroyed) return copySnapshot();
    finiteNumber(scrollTop, 'scrollTop');
    const candidateMetrics = readMetrics(nextMetrics);
    const candidateLayout = buildLayout(inputNodes, candidateMetrics);
    cancelTimer();
    commitLayout(candidateLayout, candidateMetrics);
    return refresh(scrollTop, { force: true });
  }

  function setMetrics(nextMetrics, scrollTop = currentScrollTop) {
    if (destroyed) return copySnapshot();
    finiteNumber(scrollTop, 'scrollTop');
    const candidateMetrics = readMetrics(nextMetrics);
    const heightsChanged = !metrics || hasOwn(nextMetrics, mode === 'fixed' ? 'rowHeight' : 'heightByType');
    const candidateLayout = heightsChanged ? buildLayout(nodes, candidateMetrics) : null;
    cancelTimer();
    if (candidateLayout) commitLayout(candidateLayout, candidateMetrics);
    else metrics = candidateMetrics;
    return refresh(scrollTop, { force: heightsChanged });
  }

  function nearWindowEdge(scrollTop, direction) {
    if (!snapshot.visibleList.length) return true;
    const first = snapshot.visibleList[0].rect;
    const last = snapshot.visibleList[snapshot.visibleList.length - 1].rect;
    const viewportBottom = scrollTop + metrics.viewportHeight;
    if (scrollTop < first.top || viewportBottom > last.bottom) return true;
    if (direction > 0) return last.bottom - viewportBottom < metrics.viewportHeight;
    if (direction < 0) return scrollTop - first.top < metrics.viewportHeight;
    return false;
  }

  function handleScroll(scrollTop) {
    if (destroyed) return;
    finiteNumber(scrollTop, 'scrollTop');
    const direction = Math.sign(scrollTop - lastRawScrollTop);
    latestScrollTop = scrollTop;
    currentScrollTop = scrollTop;
    lastRawScrollTop = scrollTop;
    if (paused || !metrics) {
      return;
    }
    if (throttleMs === 0 || nearWindowEdge(scrollTop, direction)) {
      cancelTimer();
      runUpdate(scrollTop);
      return;
    }
    const elapsed = now() - lastRunAt;
    if (elapsed < 0) {
      cancelTimer();
      runUpdate(scrollTop);
      return;
    }
    if (timer === null && elapsed >= throttleMs) {
      runUpdate(scrollTop);
      return;
    }
    if (timer === null) {
      timer = schedule(() => {
        timer = null;
        if (!destroyed && !paused) runUpdate(latestScrollTop);
      }, Math.max(0, throttleMs - elapsed));
    }
  }

  function getGroupOffset(groupId) {
    const anchor = anchorById.get(groupId);
    return anchor ? anchor.top - metrics.topInset : null;
  }

  function beginProgrammaticScroll(groupId) {
    if (destroyed || !anchorById.has(groupId)) return copySnapshot();
    lockedGroupId = groupId;
    return refresh(currentScrollTop);
  }

  function endProgrammaticScroll(scrollTop = currentScrollTop) {
    if (destroyed) return copySnapshot();
    finiteNumber(scrollTop, 'scrollTop');
    lockedGroupId = null;
    return refresh(scrollTop);
  }

  function pause() {
    if (destroyed) return;
    cancelTimer();
    currentScrollTop = latestScrollTop;
    paused = true;
  }

  function resume(scrollTop = currentScrollTop) {
    if (destroyed) return copySnapshot();
    finiteNumber(scrollTop, 'scrollTop');
    paused = false;
    return refresh(scrollTop, { force: true });
  }

  function destroy() {
    if (destroyed) return;
    cancelTimer();
    destroyed = true;
    paused = true;
    callback = null;
    nodes = [];
    layoutNodes = [];
    anchors = [];
    anchorById.clear();
    metrics = null;
    totalHeight = 0;
    lockedGroupId = null;
    snapshot = emptySnapshot(layoutVersion);
  }

  return {
    replaceLayout,
    setMetrics,
    handleScroll,
    refresh,
    getSnapshot: copySnapshot,
    getGroupOffset,
    beginProgrammaticScroll,
    endProgrammaticScroll,
    pause,
    resume,
    destroy,
  };
}
