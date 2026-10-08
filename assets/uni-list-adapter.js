/**
 * uni-app Options API integration helpers. No business data or network access.
 * Inject query/nextTick/controller so measurement races can be tested in Node.
 */

const positive = (value, label) => {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
    return value;
};

const finite = (value, label) => {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
    return value;
};

const executeQuery = (query, scope, configure) => new Promise((resolve, reject) => {
    try {
        const batch = query().in(scope);
        configure(batch);
        batch.exec((results) => {
            if (!Array.isArray(results)) reject(new Error("Layout query returned no results"));
            else resolve(results);
        });
    } catch (error) {
        reject(error);
    }
});

const measuredMetrics = (mode, samples, listRect, viewportHeight, topInset) => {
    positive(listRect && listRect.width, "list width");
    positive(viewportHeight, "viewport height");
    finite(topInset, "top inset");
    if (topInset < 0) throw new Error("top inset must not be negative");
    const heightByType = {};
    Object.keys(samples).forEach((type) => {
        const rect = samples[type];
        positive(rect && rect.width, `${type} sample width`);
        positive(rect && rect.height, `${type} sample height`);
        if (Math.abs(rect.width - listRect.width) > 1) {
            throw new Error("Measurement samples must use the list width");
        }
        heightByType[type] = rect.height;
    });
    if (mode === "fixed") {
        return { viewportHeight, topInset, rowHeight: positive(heightByType.item, "item height") };
    }
    if (mode !== "typed" || Object.keys(heightByType).length === 0) {
        throw new Error("Choose fixed or typed mode and provide its samples");
    }
    return { viewportHeight, topInset, heightByType };
};

/** Page coordinates: list document top = viewport rect.top + paired viewport offset. */
export async function readPageLayout({
    query, scope, listSelector, sampleSelectors, viewportHeight, mode = "fixed", topInset = 0,
}) {
    const types = Object.keys(sampleSelectors);
    const results = await executeQuery(query, scope, (batch) => {
        types.forEach((type) => batch.select(sampleSelectors[type]).boundingClientRect());
        batch.select(listSelector).boundingClientRect();
        batch.selectViewport().scrollOffset();
    });
    const listRect = results[types.length];
    const offset = results[types.length + 1];
    const scrollTop = finite(offset && offset.scrollTop, "page scrollTop");
    const listTop = finite(listRect && listRect.top, "list top") + scrollTop;
    const samples = Object.fromEntries(types.map((type, index) => [type, results[index]]));
    return {
        listTop,
        scrollTop: Math.max(0, scrollTop),
        metrics: measuredMetrics(mode, samples, listRect, viewportHeight, topInset),
    };
}

/** Container coordinates: never use selectViewport for a scroll-view's position. */
export async function readScrollViewLayout({
    query, scope, scrollSelector, listSelector, sampleSelectors, mode = "typed", topInset = 0,
}) {
    const types = Object.keys(sampleSelectors);
    const results = await executeQuery(query, scope, (batch) => {
        types.forEach((type) => batch.select(sampleSelectors[type]).boundingClientRect());
        batch.select(listSelector).boundingClientRect();
        batch.select(scrollSelector).boundingClientRect();
        batch.select(scrollSelector).scrollOffset();
    });
    const listRect = results[types.length];
    const containerRect = results[types.length + 1];
    const offset = results[types.length + 2];
    const scrollTop = finite(offset && offset.scrollTop, "container scrollTop");
    const listTop = finite(listRect && listRect.top, "list top")
        - finite(containerRect && containerRect.top, "container top") + scrollTop;
    const samples = Object.fromEntries(types.map((type, index) => [type, results[index]]));
    return {
        listTop,
        scrollTop: Math.max(0, scrollTop),
        metrics: measuredMetrics(mode, samples, listRect, containerRect.height, topInset),
    };
}

export async function readScrollViewOffset({ query, scope, scrollSelector }) {
    const results = await executeQuery(query, scope, (batch) => {
        batch.select(scrollSelector).scrollOffset();
    });
    return Math.max(0, finite(results[0] && results[0].scrollTop, "container scrollTop"));
}

/**
 * Lifecycle/measurement gate shared by both examples.
 * readLayout returns { metrics, listTop, scrollTop }; each scroll event uses the
 * same owner (page or scroll-view). Negative list-local positions are preserved.
 */
export function createUniListAdapter({
    controller, nextTick, getNodes, getSample, onSample, readLayout, onLayout, onError,
}) {
    let ready = false;
    let active = false;
    let disposed = false;
    let measuring = false;
    let measureToken = 0;
    let scrollVersion = 0;
    let scrollTop = 0;
    let layout = null;
    controller.pause();

    const valid = (token) => !disposed && active && token === measureToken;
    const localTop = () => scrollTop - (layout ? layout.listTop : 0);

    const measure = async () => {
        if (!ready || !active || disposed) return false;
        const token = ++measureToken;
        measuring = true;
        controller.pause();
        try {
            onError(null);
            onSample(getSample());
            await nextTick();
            if (!valid(token)) return false;
            const version = scrollVersion;
            const result = await readLayout();
            if (!valid(token)) return false;
            finite(result.listTop, "list top");
            finite(result.scrollTop, "scrollTop");
            // A newer scroll event wins over an older asynchronous measurement.
            const nextScrollTop = version === scrollVersion ? Math.max(0, result.scrollTop) : scrollTop;
            controller.replaceLayout(getNodes(), result.metrics, nextScrollTop - result.listTop);
            layout = { ...result, scrollTop: nextScrollTop };
            scrollTop = nextScrollTop;
            onLayout(layout);
            controller.resume(localTop());
            return true;
        } catch (error) {
            if (!valid(token)) return false;
            layout = null;
            onError(error);
            return false;
        } finally {
            // An obsolete task must not hide the current task's measurement sample.
            if (token === measureToken) {
                measuring = false;
                onSample(null);
            }
        }
    };

    const hide = () => {
        if (disposed) return;
        active = false;
        measureToken += 1;
        measuring = false;
        controller.pause();
        onSample(null);
    };

    return {
        onReady() { if (!disposed) ready = true; return measure(); },
        onShow() { if (!disposed) active = true; return measure(); },
        onResize: measure,
        onHide: hide,
        measure,
        handleScroll(value) {
            if (!active || disposed || !Number.isFinite(value)) return;
            scrollTop = Math.max(0, value);
            scrollVersion += 1;
            if (layout && !measuring) controller.handleScroll(localTop());
        },
        refreshData() {
            if (!active || disposed) return false;
            if (!layout || measuring) return measure();
            // replaceLayout forces publication even when the visible bounds match.
            controller.replaceLayout(getNodes(), layout.metrics, localTop());
            return true;
        },
        getLayout: () => layout && { ...layout, scrollTop },
        getScrollTop: () => scrollTop,
        getLocalScrollTop: localTop,
        isActive: () => active && !disposed,
        dispose() {
            if (disposed) return;
            hide();
            disposed = true;
            layout = null;
            controller.destroy();
        },
    };
}
