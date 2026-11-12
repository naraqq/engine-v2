/**
 * Shared plumbing for the terminal commands: talking to the engine API,
 * starting the engine when it isn't running, and terminal output.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
export const BASE = (process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');

// Thrown, not process.exit(), so callers' finally blocks still stop the engine.
export function fail(message) {
    throw new Error(message);
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ------------------------------------------------------------------ API

export async function api(method, route, body) {
    let response;
    try {
        response = await fetch(BASE + route, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (error) {
        throw new Error(`Engine API not reachable at ${BASE} (${error.cause?.message || error.message})`);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        const details = payload.error?.details ? ` ${JSON.stringify(payload.error.details)}` : '';
        throw new Error((payload.error?.message || `HTTP ${response.status}`) + details);
    }
    return payload.data;
}

async function isUp() {
    try {
        const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
        return response.ok;
    } catch {
        return false;
    }
}

// ------------------------------------------------------- child processes

/**
 * Kills a process and everything it started (the engine's Chrome, the
 * translator's workers). On Windows child.kill() only ends the one process,
 * and its children keep running, so use taskkill /T.
 */
export function killTree(pid) {
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch { /* already gone */ }
}

const children = new Set();
/** Remembers a child process so killChildren() can end it; returns it. */
export function track(child) {
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
}
export const childPids = () => [...children].map(ch => ch.pid).filter(Boolean);
/** Ends every tracked child process tree right now (synchronous, safe on exit). */
export function killChildren() {
    for (const child of children) killTree(child.pid);
    children.clear();
}
process.once('exit', killChildren);

/** Starts the API from source when nothing answers; returns a stop function. */
export async function ensureServer() {
    if (await isUp()) return () => {};

    const port = new URL(BASE).port || '3000';
    const logDir = path.join(ROOT, 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'download-cli-server.log');
    const out = openSync(logFile, 'a');

    status('Starting the engine…');
    const child = track(spawn(process.execPath, ['--no-warnings', '--loader', './loader.mjs', '--import', 'tsx', 'src/index.ts'], {
        cwd: ROOT,
        env: { ...process.env, PORT: port, LOG_LEVEL: process.env.LOG_LEVEL || 'warn' },
        stdio: ['ignore', out, out],
        windowsHide: true,
    }));
    let exited = false;
    child.on('exit', () => { exited = true; });

    const deadline = Date.now() + 90_000;
    while (!(await isUp())) {
        if (exited) fail(`The engine stopped while starting. See ${logFile}`);
        if (Date.now() > deadline) {
            killTree(child.pid);
            fail(`The engine did not start within 90 s. See ${logFile}`);
        }
        await sleep(1000);
    }
    clearStatus();
    // Also killed by killChildren() on exit, Ctrl+C included.
    return () => { if (!exited) killTree(child.pid); };
}

// --------------------------------------------------------------- output

const tty = process.stdout.isTTY;
let lineOpen = false;

// Colors only on a terminal; NO_COLOR turns them off, FORCE_COLOR=1 on.
const useColor = process.env.FORCE_COLOR !== undefined
    ? process.env.FORCE_COLOR !== '0'
    : Boolean(tty) && !('NO_COLOR' in process.env);
const paint = (open, close) => text => useColor ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);
export const c = {
    bold: paint(1, 22),
    dim: paint(2, 22),
    red: paint(31, 39),
    green: paint(32, 39),
    yellow: paint(33, 39),
    blue: paint(34, 39),
    magenta: paint(35, 39),
    cyan: paint(36, 39),
    gray: paint(90, 39),
};
const ANSI = /\x1b\[[0-9;]*m/g;

/** A line that rewrites itself in place (progress); hidden when piped. */
export function status(text) {
    if (tty) {
        const width = (process.stdout.columns || 100) - 1;
        const plain = text.replace(ANSI, '');
        // Too long: drop the colors rather than cut an escape code in half.
        const line = plain.length > width ? plain.slice(0, width) : text + ' '.repeat(width - plain.length);
        process.stdout.write('\r' + line);
        lineOpen = true;
    }
}

function clearStatus() {
    if (lineOpen) {
        process.stdout.write('\r' + ' '.repeat((process.stdout.columns || 100) - 1) + '\r');
        lineOpen = false;
    }
}

/** A permanent line. */
export function say(text = '') {
    clearStatus();
    console.log(text);
}

export function bar(percent, width = 24) {
    const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
    return c.cyan('█'.repeat(filled)) + c.gray('░'.repeat(width - filled));
}

// ------------------------------------------------------------- chapters

export function chapterNumber(chapter) {
    // From the URL first: /chapter/126 (Asura), /chapter-48 (Madara sites);
    // /chapter-10-5 means 10.5.
    const fromUrl = chapter.id.match(/\/chapter[-_/](\d+)(?:[.\-_](\d+))?\/?$/i);
    if (fromUrl) return Number(fromUrl[2] ? `${fromUrl[1]}.${fromUrl[2]}` : fromUrl[1]);
    const m = chapter.title.match(/(?:ch(?:apter)?\.?\s*)(\d+(?:\.\d+)?)/i)
        || chapter.title.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : NaN;
}

export const normalize = s => String(s ?? '').toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** "121, 122, 123" or "121–140" for long consecutive runs. */
export function describeNumbers(numbers) {
    if (numbers.length > 6) return `${numbers[0]}–${numbers[numbers.length - 1]}`;
    return numbers.join(', ');
}

// ------------------------------------------------------------- progress

/**
 * Polls downloads one at a time until each ends, drawing a progress line.
 * [indent] prefixes the finished lines (used by the Montoon sync).
 */
export async function follow(ids, label, indent = '') {
    const finished = new Map();
    while (finished.size < ids.length) {
        for (const id of ids) {
            if (finished.has(id)) continue;
            const d = await api('GET', `/api/v1/downloads/${id}`);
            if (d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled') {
                finished.set(id, d);
                const name = d.mangaTitle || d.mangaId;
                say(d.status === 'completed'
                    ? `${indent}${c.green(`✔ ${name}`)}`
                    : `${indent}${c.red(`✖ ${name}: ${d.error || d.status}`)}`);
                continue;
            }
            const prefix = ids.length > 1 ? c.gray(`[${finished.size + 1}/${ids.length}] `) : '';
            const where = d.currentChapter ? c.gray(`  ${d.currentChapter}`) : '';
            status(`${indent}${prefix}${c.bold(d.mangaTitle || label)}  ${bar(d.progress)} ${String(d.progress).padStart(3)}%${where}`);
            break;
        }
        await sleep(1500);
    }
    return [...finished.values()];
}
