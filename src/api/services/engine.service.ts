import { HakuNeko } from '../../engine/HakuNeko.js';
import type { MangaPlugin } from '../../engine/providers/MangaPlugin.js';
import type { SourceInfo, MangaInfo, ChapterInfo } from '../types/responses.js';
import { Errors } from '../middleware/error-handler.js';
import { logger } from '../../config/logger.js';

/**
 * Engine service that wraps HakuNeko for API usage
 */
class EngineService {
    private hakuneko: HakuNeko | null = null;
    private initialized = false;

    /**
     * Initialize the HakuNeko engine
     */
    public async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        try {
            logger.info('🚀 Initializing HakuNeko engine...');
            this.hakuneko = new HakuNeko();

            // Expose HakuNeko instance globally for legacy code that expects it
            (globalThis as any).HakuNeko = this.hakuneko;

            // Initialize with empty frontends array (no UI needed)
            await this.hakuneko.Initialze([]);

            this.initialized = true;
            logger.info(`✅ HakuNeko engine initialized with ${this.getAllSources().length} sources`);
        } catch (error) {
            logger.error('Failed to initialize HakuNeko engine:', error);
            throw Errors.InternalError('Failed to initialize manga engine');
        }
    }

    /**
     * Get HakuNeko instance
     */
    private getEngine(): HakuNeko {
        if (!this.hakuneko || !this.initialized) {
            throw Errors.InternalError('Engine not initialized');
        }
        return this.hakuneko;
    }

    /**
     * Get all manga sources
     */
    public getAllSources(): SourceInfo[] {
        const engine = this.getEngine();
        const plugins = engine.PluginController.WebsitePlugins;

        return plugins.map((plugin: any) => this.mapPluginToSource(plugin));
    }

    /**
     * Get a specific source by ID
     */
    public getSource(sourceId: string): SourceInfo {
        const engine = this.getEngine();
        const plugin = engine.PluginController.WebsitePlugins.find(
            (p: any) => p.Identifier === sourceId
        );

        if (!plugin) {
            throw Errors.SourceNotFound(sourceId);
        }

        return this.mapPluginToSource(plugin);
    }

    /**
     * Search manga in a specific source
     */
    public async searchManga(sourceId: string, query: string): Promise<MangaInfo[]> {
        logger.info(`🔍 Starting manga search: source="${sourceId}", query="${query}"`);

        const engine = this.getEngine();
        const plugin = engine.PluginController.WebsitePlugins.find(
            (p: any) => p.Identifier === sourceId
        );

        if (!plugin) {
            logger.warn(`❌ Source not found: ${sourceId}`);
            throw Errors.SourceNotFound(sourceId);
        }

        logger.info(`✅ Found plugin: ${plugin.Title} (${sourceId})`);

        // Sites with their own search answer in seconds; crawling the whole
        // catalog (below) can take minutes on the first query.
        if (query?.trim() && (plugin as any).SupportsSiteSearch) {
            try {
                const found = await (plugin as any).Search(query.trim());
                logger.info(`✅ Site search returned ${found.length} results`);
                return found.map((manga: any) => this.mapMangaToInfo(manga, sourceId));
            } catch (error) {
                logger.warn('Site search failed, falling back to catalog filtering', error);
            }
        }

        try {
            // Check if entries are already loaded
            const currentEntries = plugin.Entries.Value;
            logger.info(`📦 Current cached entries count: ${currentEntries.length}`);

            // If no entries cached or very few, fetch fresh data
            if (currentEntries.length === 0) {
                logger.info(`🔄 No cached entries found, fetching fresh manga list from source...`);
                logger.info(`⏳ Calling plugin.Update() to fetch manga list...`);

                const updateStartTime = Date.now();
                await plugin.Update();
                const updateDuration = Date.now() - updateStartTime;

                const updatedEntries = plugin.Entries.Value;
                logger.info(`✅ Update completed in ${updateDuration}ms, fetched ${updatedEntries.length} manga entries`);
            } else {
                logger.info(`✅ Using ${currentEntries.length} cached entries`);
            }

            // Get the entries after update
            const mangas = plugin.Entries;
            const allMangas = mangas.Value;
            logger.info(`📚 Total manga available for search: ${allMangas.length}`);

            // Filter by query if provided
            let filtered = allMangas;
            if (query && query.trim().length > 0) {
                const queryLower = query.toLowerCase().trim();
                logger.info(`🔎 Filtering manga with query: "${queryLower}"`);

                filtered = allMangas.filter((manga: any) => {
                    const titleMatch = manga.Title.toLowerCase().includes(queryLower);
                    if (titleMatch) {
                        logger.debug(`✓ Match found: "${manga.Title}"`);
                    }
                    return titleMatch;
                });

                logger.info(`📊 Search results: ${filtered.length} manga matched out of ${allMangas.length} total`);
            } else {
                logger.info(`📊 No query provided, returning all ${allMangas.length} manga`);
            }

            const results = filtered.map((manga: any) => this.mapMangaToInfo(manga, sourceId));
            logger.info(`✅ Search completed successfully, returning ${results.length} results`);

            return results;
        } catch (error) {
            logger.error(`❌ Error searching manga in ${sourceId}:`, {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                sourceId,
                query,
            });

            const message = error instanceof Error ? error.message : 'Unknown error';
            throw Errors.InternalError(`Failed to search manga: ${message}`);
        }
    }

    /**
     * List all manga from a source
     */
    public async listManga(sourceId: string): Promise<MangaInfo[]> {
        logger.info(`📋 Listing all manga from source: ${sourceId}`);

        const engine = this.getEngine();
        const plugin = engine.PluginController.WebsitePlugins.find(
            (p: any) => p.Identifier === sourceId
        );

        if (!plugin) {
            logger.warn(`❌ Source not found: ${sourceId}`);
            throw Errors.SourceNotFound(sourceId);
        }

        logger.info(`✅ Found plugin: ${plugin.Title} (${sourceId})`);

        try {
            // Check if entries are already loaded
            const currentEntries = plugin.Entries.Value;
            logger.info(`📦 Current cached entries count: ${currentEntries.length}`);

            // If no entries cached, fetch fresh data
            if (currentEntries.length === 0) {
                logger.info(`🔄 No cached entries found, fetching fresh manga list from source...`);
                logger.info(`⏳ Calling plugin.Update() to fetch manga list...`);

                const updateStartTime = Date.now();
                await plugin.Update();
                const updateDuration = Date.now() - updateStartTime;

                const updatedEntries = plugin.Entries.Value;
                logger.info(`✅ Update completed in ${updateDuration}ms, fetched ${updatedEntries.length} manga entries`);
            } else {
                logger.info(`✅ Using ${currentEntries.length} cached entries`);
            }

            const mangas = plugin.Entries;
            const results = mangas.Value.map((manga: any) => this.mapMangaToInfo(manga, sourceId));

            logger.info(`✅ List completed successfully, returning ${results.length} manga`);
            return results;
        } catch (error) {
            logger.error(`❌ Error listing manga from ${sourceId}:`, {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                sourceId,
            });

            const message = error instanceof Error ? error.message : 'Unknown error';
            throw Errors.InternalError(`Failed to list manga: ${message}`);
        }
    }

    /** A site's discovery list: 'trending' or 'latest' (recently updated). */
    public async discoverManga(sourceId: string, list: string, limit = 20): Promise<MangaInfo[]> {
        if (list === 'trending') return this.listTrendingManga(sourceId, limit);
        const plugin = this.getEngine().PluginController.WebsitePlugins.find(
            (p: any) => p.Identifier === sourceId
        );
        if (!plugin) throw Errors.SourceNotFound(sourceId);
        if (list !== 'latest') throw Errors.BadRequest(`Unknown list "${list}". Use trending or latest.`);
        try {
            const mangas = await (plugin as any).FetchLatest(limit);
            return mangas.map((manga: any) => this.mapMangaToInfo(manga, sourceId));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw Errors.InternalError(`Source does not support the latest list: ${message}`);
        }
    }

    public async listTrendingManga(sourceId: string, limit = 10): Promise<MangaInfo[]> {
        const plugin = this.getEngine().PluginController.WebsitePlugins.find(
            (p: any) => p.Identifier === sourceId
        );
        if (!plugin) throw Errors.SourceNotFound(sourceId);

        try {
            const mangas = await (plugin as any).FetchTrending(limit);
            for (const manga of mangas) {
                if (!plugin.Entries.Value.some((entry: any) => entry.Identifier === manga.Identifier)) {
                    (plugin.Entries.Value as unknown[]).push(manga);
                }
            }
            return mangas.map((manga: any) => this.mapMangaToInfo(manga, sourceId));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw Errors.InternalError(`Source does not support trending manga: ${message}`);
        }
    }

    /**
     * Get manga details
     */
    public async getManga(sourceId: string, mangaId: string): Promise<MangaInfo> {
        const engine = this.getEngine();
        const plugin = engine.PluginController.WebsitePlugins.find(
            (p: any) => p.Identifier === sourceId
        );

        if (!plugin) {
            throw Errors.SourceNotFound(sourceId);
        }

        try {
            const mangas = await plugin.Entries;
            let manga = mangas.Value.find((m: any) => m.Identifier === mangaId);

            if (!manga) {
                try {
                    manga = await plugin.TryGetEntry(mangaId);
                } catch (err) {
                    // Ignore fallback error
                }
            }

            if (!manga) {
                throw Errors.MangaNotFound(mangaId);
            }

            return this.mapMangaToInfo(manga, sourceId);
        } catch (error) {
            if (error instanceof Error && error.message.includes('not found')) {
                throw error;
            }
            logger.error(`Error getting manga ${mangaId}:`, error);
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw Errors.InternalError(`Failed to get manga: ${message}`);
        }
    }

    /**
     * Get chapters for a manga
     */
    public async getChapters(sourceId: string, mangaId: string): Promise<ChapterInfo[]> {
        logger.info(`📖 Getting chapters: source="${sourceId}", mangaId="${mangaId}"`);

        const engine = this.getEngine();
        const plugin = engine.PluginController.WebsitePlugins.find(
            (p: any) => p.Identifier === sourceId
        );

        if (!plugin) {
            logger.warn(`❌ Source not found: ${sourceId}`);
            throw Errors.SourceNotFound(sourceId);
        }

        logger.info(`✅ Found plugin: ${plugin.Title} (${sourceId})`);

        try {
            // Try to find manga in cache first
            const currentMangas = plugin.Entries.Value;
            logger.info(`📦 Current cached manga count: ${currentMangas.length}`);

            let manga = currentMangas.find((m: any) => m.Identifier === mangaId);

            if (!manga) {
                logger.info(`🔄 Manga not in cache, attempting to resolve directly...`);
                try {
                    manga = await plugin.TryGetEntry(mangaId);
                } catch (err) {
                    // Ignore fallback error
                }
                
                if (!manga) {
                    logger.info(`🔄 Manga resolution failed, creating direct manga object...`);
                    // Create manga object directly without fetching all mangas
                    // This is much faster than fetching the entire manga list
                    manga = plugin.CreateEntry(mangaId, `Manga ${mangaId}`);
                    logger.info(`✅ Created manga object for ID: ${mangaId}`);
                } else {
                    logger.info(`✅ Resolved manga object directly: "${manga.Title}"`);
                }
            } else {
                logger.info(`✅ Found manga in cache: "${manga.Title}" (${mangaId})`);
            }

            // Check if chapters are already loaded for this manga
            const currentChapters = manga.Entries.Value;
            logger.info(`📦 Current cached chapters count: ${currentChapters.length}`);

            // If no chapters cached, fetch fresh data
            if (currentChapters.length === 0) {
                logger.info(`🔄 No cached chapters found, fetching from source...`);
                logger.info(`⏳ Calling manga.Update() to fetch chapter list...`);
                logger.info(`[DEBUG] Manga ID: ${mangaId}`);
                logger.info(`[DEBUG] Manga Title: ${manga.Title}`);
                logger.info(`[DEBUG] Source: ${sourceId}`);

                const updateStartTime = Date.now();
                try {
                    await manga.Update();
                    const updateDuration = Date.now() - updateStartTime;

                    const updatedChapters = manga.Entries.Value;
                    logger.info(`✅ Update completed in ${updateDuration}ms, fetched ${updatedChapters.length} chapters`);

                    // If still 0 chapters, log more details for debugging
                    if (updatedChapters.length === 0) {
                        logger.warn(`⚠️  Update() returned 0 chapters - this may indicate:`);
                        logger.warn(`   - Website structure changed`);
                        logger.warn(`   - Cloudflare/anti-bot blocking`);
                        logger.warn(`   - Invalid manga ID format`);
                        logger.warn(`   - Manga no longer available on source`);
                        logger.info(`[DEBUG] Manga.Entries.Value type: ${typeof manga.Entries.Value}`);
                        logger.info(`[DEBUG] Manga.Entries.Value is Array: ${Array.isArray(manga.Entries.Value)}`);
                    }
                } catch (updateError) {
                    const updateDuration = Date.now() - updateStartTime;
                    logger.error(`❌ manga.Update() threw error after ${updateDuration}ms:`, {
                        error: updateError instanceof Error ? updateError.message : String(updateError),
                        stack: updateError instanceof Error ? updateError.stack : undefined,
                        mangaId,
                        sourceId,
                    });
                    // Re-throw to be handled by outer catch
                    throw updateError;
                }
            } else {
                logger.info(`✅ Using ${currentChapters.length} cached chapters`);
            }

            const chapters = manga.Entries;
            const results = chapters.Value.map((chapter: any) => ({
                id: chapter.Identifier,
                title: chapter.Title,
                mangaId,
                sourceId,
                number: chapter.Number,
                volume: chapter.Volume,
                language: chapter.Language,
            }));

            logger.info(`✅ Returning ${results.length} chapters for manga "${manga.Title}"`);
            return results;
        } catch (error) {
            if (error instanceof Error && error.message.includes('not found')) {
                throw error;
            }

            logger.error(`❌ Error getting chapters for ${mangaId}:`, {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                sourceId,
                mangaId,
            });

            const message = error instanceof Error ? error.message : 'Unknown error';
            throw Errors.InternalError(`Failed to get chapters: ${message}`);
        }
    }

    /**
     * Get download manager
     */
    public getDownloadManager() {
        return this.getEngine().DownloadManager;
    }

    /**
     * Get plugin controller
     */
    public getPluginController() {
        return this.getEngine().PluginController;
    }

    /**
     * Get storage controller
     */
    public getStorageController() {
        return this.getEngine().StorageController;
    }

    /**
     * Map plugin to source info
     */
    private mapPluginToSource(plugin: any): SourceInfo {
        return {
            id: plugin.Identifier,
            title: plugin.Title,
            url: plugin.URI.href,
            icon: plugin.Icon,
            tags: plugin.Tags.Value.map((tag: any) => tag.Title),
            supportsSearch: true, // Most plugins support search
            supportsList: true, // Most plugins support listing
            status: 'active', // TODO: Implement status checking
        };
    }

    /**
     * Map manga to manga info
     */
    private mapMangaToInfo(manga: any, sourceId: string): MangaInfo {
        return {
            id: manga.Identifier,
            title: manga.Title,
            sourceId,
            url: manga.Identifier, // Usually the URL or unique identifier
        };
    }
}

// Export singleton instance
export const engineService = new EngineService();
