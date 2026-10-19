/**
 * Bounded native scroll reconciliation. No uni/Vue dependency; the host injects
 * the real scroll-view query, adapter update and visibility predicate.
 */
export function createScrollViewSync({
    readOffset, applyOffset, isActive, onError = () => {},
    quietMs = 120, maxSamples = 8, queryTimeoutMs = 800, tolerance = 1,
    clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
}) {
    for (const callback of [readOffset, applyOffset, isActive, onError, clock.setTimeout, clock.clearTimeout]) {
        if (typeof callback !== 'function') throw new TypeError('Scroll sync callbacks must be functions');
    }
    if (!Number.isFinite(quietMs) || quietMs <= 0 || !Number.isInteger(maxSamples) || maxSamples < 2
        || !Number.isFinite(queryTimeoutMs) || queryTimeoutMs <= 0 || !Number.isFinite(tolerance) || tolerance < 0) {
        throw new RangeError('Invalid scroll sync limits');
    }
    const cancelled = Symbol('cancelled');
    const pending = new Set();
    let version = 0;
    let disposed = false;
    let resetting = false;
    const valid = (token) => !disposed && isActive() && token === version;

    const cancel = () => {
        version += 1;
        resetting = false;
        for (const stop of [...pending]) stop();
    };

    // Cancellation settles waits immediately. The native operation may still
    // complete later, but its value/error can no longer reach the view.
    const wait = (token, start, timeoutMs, timeoutError) => new Promise((resolve, reject) => {
        if (!valid(token)) { resolve(cancelled); return; }
        let done = false;
        let timer;
        const settle = (value, error) => {
            if (done) return;
            done = true;
            clock.clearTimeout(timer);
            pending.delete(stop);
            if (error) reject(error);
            else resolve(value);
        };
        const stop = () => settle(cancelled);
        pending.add(stop);
        timer = clock.setTimeout(() => settle(undefined, timeoutError), timeoutMs);
        if (start) Promise.resolve().then(() => valid(token) ? start() : cancelled)
            .then((value) => settle(value), (error) => settle(undefined, error));
    });
    const delay = (token) => wait(token, null, quietMs);
    const query = async (token) => {
        const value = await wait(token, readOffset, queryTimeoutMs, new Error('Native scroll query timed out'));
        if (!valid(token) || value === cancelled) return cancelled;
        if (!Number.isFinite(value)) throw new Error('Native scrollTop must be finite');
        return Math.max(0, value);
    };

    const reconcile = async (token, deferred) => {
        try {
            if (deferred) await delay(token);
            let previous = null;
            for (let sample = 0; sample < maxSamples && valid(token); sample += 1) {
                const actual = await query(token);
                if (actual === cancelled || !valid(token)) return false;
                applyOffset(actual);
                if (previous !== null && Math.abs(actual - previous) <= tolerance) return true;
                previous = actual;
                if (sample + 1 < maxSamples) await delay(token);
            }
            // Still moving: the last valid offset was applied. A new event can
            // start another bounded burst; never turn this into permanent polling.
            return false;
        } catch (error) {
            if (valid(token)) onError(error);
            return false;
        }
    };

    return {
        schedule() {
            // Reset-generated scroll events must not cancel the reset itself.
            if (resetting || disposed || !isActive()) return Promise.resolve(false);
            cancel();
            return reconcile(version, true);
        },
        reconcile() {
            if (resetting || disposed || !isActive()) return Promise.resolve(false);
            cancel();
            return reconcile(version, false);
        },
        async resetToTop({ getBoundTop, setBoundTop, nextTick }) {
            cancel();
            const token = version;
            if (!valid(token)) return false;
            resetting = true;
            try {
                // Flush any preceding command before toggling. Otherwise two
                // confirmations in one view batch can coalesce 0 -> 0.1 -> 0.
                await wait(token, nextTick, queryTimeoutMs, new Error('Scroll reset view update timed out'));
                if (!valid(token)) return false;
                // A tiny alternate command makes repeated resets observable.
                setBoundTop(getBoundTop() === 0 ? 0.1 : 0);
                await wait(token, nextTick, queryTimeoutMs, new Error('Scroll reset view update timed out'));
                for (let sample = 0; sample < maxSamples && valid(token); sample += 1) {
                    const actual = await query(token);
                    if (actual === cancelled || !valid(token)) return false;
                    if (actual <= tolerance) {
                        applyOffset(actual);
                        return true;
                    }
                    if (sample + 1 < maxSamples) await delay(token);
                }
                if (valid(token)) throw new Error('Scroll reset did not reach the top');
                return false;
            } catch (error) {
                if (valid(token)) onError(error);
                return false;
            } finally {
                if (token === version) resetting = false;
            }
        },
        cancel,
        dispose() { cancel(); disposed = true; },
    };
}
