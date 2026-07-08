/**
 * Script to find all working English connectors and how many mangas each offers.
 *
 * Usage: NODE_OPTIONS='--loader ./loader.mjs' npx tsx scripts/check-english-connectors.ts
 */

import * as websites from '../src/engine/websites/_index.js';
import { Tags } from '../src/engine/Tags.js';
import { SetupFetchProvider } from '../src/engine/platform/FetchProvider.js';
import { FeatureFlags } from '../src/engine/FeatureFlags.js';
import { SettingsManager } from '../src/engine/SettingsManager.js';
import { Initialize as InitGlobalSettings } from '../src/engine/SettingsGlobal.js';
import { CreateStorageController } from '../src/engine/StorageController.js';
import { promises as fs } from 'fs';

const TIMEOUT_MS = 60_000;
const CONCURRENCY = 5;

function pad(s: string, n: number): string {
    return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
    for (const dir of ['storage', 'storage/downloads', 'storage/temp', 'storage/database', 'storage/cache', 'logs']) {
        await fs.mkdir(dir, { recursive: true });
    }

    // Suppress noisy engine logs
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origInfo = (console as any).info;
    const scriptLog = (...args: any[]) => origLog.apply(console, args);

    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    (console as any).info = () => {};

    const storageController = CreateStorageController();
    const settingsManager = new SettingsManager(storageController);
    const featureFlags = new FeatureFlags(settingsManager);
    await featureFlags.Initialize();
    SetupFetchProvider(featureFlags);

    await InitGlobalSettings(settingsManager, []);
    (globalThis as any).HakuNeko = {
        SettingsManager: settingsManager,
        FeatureFlags: featureFlags,
    };

    const allScrapers = Object.entries(websites).map(([exportName, WebsiteClass]) => {
        try {
            return { exportName, scraper: new (WebsiteClass as any)() };
        } catch {
            return null;
        }
    }).filter(Boolean);

    const englishTag = Tags.Language.English;
    const englishScrapers = allScrapers.filter(entry =>
        entry.scraper.Tags.some((tag: any) => tag.titleKey === englishTag.titleKey)
    );

    scriptLog(`Found ${englishScrapers.length} English connectors out of ${allScrapers.length} total.`);
    scriptLog(`Testing each connector (${TIMEOUT_MS / 1000}s timeout, ${CONCURRENCY} parallel)...\n`);

    const results: { id: string; title: string; count: number }[] = [];
    const failures: { id: string; title: string; error: string }[] = [];
    let done = 0;

    for (let i = 0; i < englishScrapers.length; i += CONCURRENCY) {
        const batch = englishScrapers.slice(i, i + CONCURRENCY);

        const promises = batch.map(async (entry) => {
            const { scraper } = entry;
            const id: string = scraper.Identifier;
            const title: string = scraper.Title;

            try {
                const plugin = scraper.CreatePlugin(storageController, settingsManager);

                const count = await Promise.race([
                    (async () => {
                        await plugin.Update();
                        return plugin.Entries.Value.length as number;
                    })(),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
                    ),
                ]);

                done++;
                results.push({ id, title, count });
                scriptLog(`[${done}/${englishScrapers.length}] OK    ${pad(title, 35)} ${count} mangas`);
            } catch (err: any) {
                done++;
                const msg = (err?.message ?? String(err)).split('\n')[0].slice(0, 60);
                failures.push({ id, title, error: msg });
                scriptLog(`[${done}/${englishScrapers.length}] FAIL  ${pad(title, 35)} ${msg}`);
            }
        });

        await Promise.all(promises);
    }

    // Restore logging for summary
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    (console as any).info = origInfo;

    console.log('\n' + '='.repeat(90));
    console.log('WORKING ENGLISH CONNECTORS');
    console.log('='.repeat(90));

    const working = results.filter(r => r.count > 0);
    working.sort((a, b) => b.count - a.count);

    console.log(`\n  ${pad('#', 5)} ${pad('Name', 35)} ${pad('ID', 35)} Manga Count`);
    console.log('  ' + '-'.repeat(85));

    for (let i = 0; i < working.length; i++) {
        const r = working[i];
        console.log(`  ${pad(String(i + 1), 5)} ${pad(r.title, 35)} ${pad(r.id, 35)} ${r.count}`);
    }

    const totalMangas = working.reduce((sum, r) => sum + r.count, 0);
    console.log(`\n  Total: ${working.length} working English connectors, ${totalMangas} mangas combined.`);
    console.log(`  Failed: ${failures.length}, Empty: ${results.filter(r => r.count === 0).length}`);

    process.exit(0);
}

main().catch(err => {
    process.stderr.write('Fatal error: ' + String(err) + '\n');
    process.exit(1);
});
