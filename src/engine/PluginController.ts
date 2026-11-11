import type { MediaInfoTracker } from './trackers/IMediaInfoTracker';
import type { MediaContainer, MediaChild } from './providers/MediaPlugin';
import type { SettingsManager } from './SettingsManager';
import type { StorageController } from './StorageController';
import * as websites from './websites/_index';

type TWebsite = MediaContainer<MediaContainer<MediaChild>>;

export class PluginController {

    private readonly _websites: TWebsite[];
    private readonly _trackers: MediaInfoTracker[];

    constructor(storageController: StorageController, settingsManager: SettingsManager) {
        // Account-based media tracking is intentionally disabled in API-only mode.
        this._trackers = [];
        this._websites = [
            ... Object.values(websites).map(website => new website().CreatePlugin(storageController, settingsManager)),
        ];
    }

    public get WebsitePlugins(): ReadonlyArray<TWebsite> {
        return this._websites;
    }

    public get InfoTrackers(): ReadonlyArray<MediaInfoTracker> {
        return this._trackers;
    }
}
