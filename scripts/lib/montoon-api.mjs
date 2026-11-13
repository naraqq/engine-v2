/**
 * Client for montoon.mn's worker API (/api/v2/worker), shared by the worker
 * and the upload command. Network trouble and server hiccups are waited out
 * (checked every 30 s) instead of crashing, unless waitOffline is false.
 */
import os from 'node:os';
import { c, say, sleep } from './cli.mjs';
import { montoonConfig } from './montoon.mjs';

const clock = () => new Date().toLocaleTimeString('en-GB');
export const log = text => say(`${c.gray(clock())} ${text}`);


export class LostJobError extends Error {
    constructor(message) {
        super(message);
        this.lost = true;
    }
}

/**
 * Montoon worker API. Network trouble and server hiccups are waited out
 * (checked every 30 s) instead of crashing the worker.
 */
export async function mt(method, route, body, { waitOffline = true } = {}) {
    const { base, token, host } = montoonConfig();
    let warned = false;
    for (;;) {
        let response;
        try {
            response = await fetch(`${base}/v2/worker${route}`, {
                method,
                headers: {
                    'X-Sync-Token': token,
                    Accept: 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(30_000),
            });
        } catch (error) {
            if (!waitOffline) throw error;
            if (!warned) log(c.yellow(`⚠ Can't reach ${host} (${error.cause?.code || error.message}). Retrying every 30 s…`));
            warned = true;
            await sleep(30_000);
            continue;
        }
        const isJson = (response.headers.get('content-type') || '').includes('json');
        const payload = isJson ? await response.json().catch(() => ({})) : {};
        const transient = response.status === 429 || response.status === 502 || response.status === 504
            || (response.status >= 520 && response.status <= 530)
            || (response.status === 500) || (response.status === 503 && !/not configured/i.test(payload.message || ''));
        if (transient && waitOffline) {
            if (!warned) log(c.yellow(`⚠ ${host} answered HTTP ${response.status}. Retrying every 30 s…`));
            warned = true;
            await sleep(30_000);
            continue;
        }
        if (!isJson) throw new Error(`${base}/v2/worker${route} is not available. Deploy the backend and run its migrations.`);
        if (response.status === 409) {
            if (payload.code) throw Object.assign(new Error(payload.message), { code: payload.code });
            throw new LostJobError(payload.message || 'Job lost.');
        }
        if (response.status === 401) throw new Error('Montoon rejected the sync token. Check MONTOON_SYNC_TOKEN.');
        if (!response.ok || payload.success === false) throw new Error(payload.message || `Montoon answered HTTP ${response.status}.`);
        if (warned) log(c.green(`✓ ${host} is reachable again.`));
        return payload;
    }
}


// ------------------------------------------------------------- activity

/** This PC's worker name (same rule as the worker uses). */
export const workerName = () => (process.env.WORKER_NAME || os.hostname()).replace(/[^\w.-]+/g, '-').slice(0, 56);

const pendingEvents = [];
let flushTimer = null;

/**
 * Adds a line to Montoon's activity timeline (/admin/activity). Sent in
 * batches in the background; never throws and never blocks the work. When
 * Montoon can't be reached, events wait (up to 200) for the next try.
 */
export function logEvent(type, message, extra = {}) {
    pendingEvents.push({ type, message: String(message).slice(0, 1000), ...extra });
    if (pendingEvents.length > 200) pendingEvents.splice(0, pendingEvents.length - 200);
    flushTimer ??= setTimeout(() => { flushTimer = null; flushEvents().catch(() => {}); }, 2000);
}

/** Sends what is waiting now (e.g. before the worker exits). */
export async function flushEvents() {
    while (pendingEvents.length) {
        const batch = pendingEvents.slice(0, 50);
        try {
            await mt('POST', '/events', { worker: workerName(), events: batch }, { waitOffline: false });
            pendingEvents.splice(0, batch.length);
        } catch {
            return; // offline or backend not deployed yet: keep them for later
        }
    }
}
