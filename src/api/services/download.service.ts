import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type { DownloadRequest, DownloadStatus, TrendingDownloadRequest, TrendingDownloadResult } from '../types/responses.js';
import { engineService } from './engine.service.js';
import { config } from '../../config/settings.js';
import { Errors } from '../middleware/error-handler.js';
import { logger } from '../../config/logger.js';
import { SanitizeFileName } from '../../engine/StorageController.js';
import { NodeComicBookArchiveExporter } from '../exporters/NodeComicBookArchiveExporter.js';
import { NodeImageDirectoryExporter } from '../exporters/NodeImageDirectoryExporter.js';
import { Priority } from '../../engine/taskpool/TaskPool.js';

/**
 * Download service for managing chapter downloads
 */
class DownloadService {
    private downloads = new Map<string, DownloadStatus>();
    private downloadDir = config.storage.downloads;
    private sequentialQueue: Promise<void> = Promise.resolve();

    constructor() {
        this.ensureDownloadDirectory();
    }

    /**
     * Ensure download directory exists
     */
    private async ensureDownloadDirectory(): Promise<void> {
        await fs.mkdir(this.downloadDir, { recursive: true });
    }

    /**
     * Create a new download
     */
    public async createDownload(request: DownloadRequest, sequential = false): Promise<DownloadStatus> {
        const downloadId = randomUUID();

        // Validate and prepare custom download path if provided
        const downloadPath = request.downloadPath
            ? path.resolve(request.downloadPath) // Convert to absolute path
            : this.downloadDir;

        // Ensure the custom download directory exists
        if (request.downloadPath) {
            try {
                await fs.mkdir(downloadPath, { recursive: true });
                logger.info(`Using custom download path: ${downloadPath}`);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error(`Failed to create custom download directory: ${downloadPath}`, error);
                throw new Error(`Invalid download path: ${errorMessage}`);
            }
        }

        const status: DownloadStatus = {
            id: downloadId,
            sourceId: request.sourceId,
            mangaId: request.mangaId || 'pending...',
            mangaUrl: request.mangaUrl,
            chapterIds: request.chapterIds,
            status: 'queued',
            progress: 0,
            format: request.format || 'cbz',
            downloadPath: request.downloadPath ? downloadPath : undefined, // Store custom path if provided
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        this.downloads.set(downloadId, status);

        const run = () => this.processDownload(downloadId, request, downloadPath).catch((error) => {
            logger.error(`Download ${downloadId} failed:`, error);
            this.updateDownloadStatus(downloadId, {
                status: 'failed',
                error: error.message,
            });
        });

        // Trending batches run one title at a time. Normal API downloads remain immediate.
        if (sequential) {
            this.sequentialQueue = this.sequentialQueue.then(run, run);
        } else {
            void run();
        }

        return status;
    }

    public async createTrendingDownloads(request: TrendingDownloadRequest): Promise<TrendingDownloadResult> {
        const sourceId = request.sourceId || 'asurascans';
        const titleLimit = Math.min(request.titleLimit || 10, 10);
        const chapterLimit = Math.min(request.chapterLimit || 5, 5);
        const titles = await engineService.listTrendingManga(sourceId, titleLimit);
        // FetchTrending initializes the adapter and may update its origin after redirects.
        const downloads: DownloadStatus[] = [];

        for (const title of titles) {
            const chapters = await engineService.getChapters(sourceId, title.id);
            // A trending title is a new series to start, so take its first
            // chapters (the list is newest first) and keep their real numbers:
            // folder chapter-1 holds episode 1.
            const chapterIds = chapters.slice(-chapterLimit).map(chapter => chapter.id);
            if (chapterIds.length === 0) continue;

            downloads.push(await this.createDownload({
                sourceId,
                mangaId: title.id,
                chapterIds,
                format: request.format || 'cbz',
                downloadPath: request.downloadPath,
            }, true));
        }

        return { sourceId, titleLimit, chapterLimit, downloads };
    }

    /**
     * Process a download
     */
    private async processDownload(downloadId: string, request: DownloadRequest, downloadPath: string): Promise<void> {
        try {
            this.updateDownloadStatus(downloadId, { status: 'downloading' });

            const plugin = engineService.getPluginController().WebsitePlugins.find(
                (p: any) => p.Identifier === request.sourceId
            );

            if (!plugin) {
                throw Errors.SourceNotFound(request.sourceId);
            }

            // Get manga
            let manga: any;
            if (request.mangaUrl) {
                manga = await plugin.TryGetEntry(request.mangaUrl);
                if (manga) {
                    this.updateDownloadStatus(downloadId, {
                        mangaId: manga.Identifier,
                        mangaTitle: manga.Title
                    });
                }
            } else if (request.mangaId) {
                const mangas = await plugin.Entries;
                manga = mangas.Value.find((m: any) => m.Identifier === request.mangaId);
                
                if (!manga) {
                    try {
                        manga = await plugin.TryGetEntry(request.mangaId);
                        if (manga) {
                            this.updateDownloadStatus(downloadId, {
                                mangaId: manga.Identifier,
                                mangaTitle: manga.Title
                            });
                        }
                    } catch (e) {
                        // Ignore fallback error
                    }
                }
            }

            if (!manga) {
                throw Errors.MangaNotFound(request.mangaUrl || request.mangaId || 'Unknown');
            }

            // Get chapters
            if (manga.Entries.Value.length === 0) {
                await manga.Update();
            }
            const chapters = await manga.Entries;

            // Log available chapter IDs for debugging
            logger.info(`Found ${chapters.Value.length} chapters for manga ${request.mangaId}`);
            logger.debug('Available chapter IDs:', chapters.Value.map((c: any) => c.Identifier));
            logger.debug('Requested chapter IDs:', request.chapterIds);

            // Sources list chapters newest first; download (and number, with
            // sequentialChapterNames) in reading order, oldest first.
            const chaptersToDownload = chapters.Value.filter((c: any) =>
                request.chapterIds.includes(c.Identifier)
            ).reverse();

            if (chaptersToDownload.length === 0) {
                const availableChapterIds = chapters.Value.map((c: any) => c.Identifier).join(', ');
                throw new Error(`No valid chapters found to download. Available chapter IDs: ${availableChapterIds}. Requested: ${request.chapterIds.join(', ')}`);
            }

            this.updateDownloadStatus(downloadId, {
                status: 'processing',
                progress: 0,
                mangaTitle: manga.Title,
            });

            // Download chapters and create export
            await this.downloadAndExport(downloadId, request, chaptersToDownload, manga.Title, downloadPath);

            this.updateDownloadStatus(downloadId, {
                status: 'completed',
                progress: 100,
                completedAt: new Date().toISOString(),
                fileUrl: `/api/v1/downloads/${downloadId}/file`,
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            logger.error(`Download processing failed for ${downloadId}:`, {
                error: errorMessage,
                stack: errorStack,
                downloadId,
                sourceId: request.sourceId,
                mangaId: request.mangaId,
            });
            throw error;
        }
    }

    /**
     * Extract chapter number from chapter title
     * Examples:
     * "Ch.001 - The Black Swordsman" -> "1"
     * "Chapter 42.5" -> "42.5"
     * "Vol.1 Chapter 3" -> "3"
     */
    /** One page image, retried with backoff so a single timeout doesn't sink the chapter. */
    private async fetchPageWithRetry(page: any, attempts = 3): Promise<Blob> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await page.Fetch(Priority.Normal, new AbortController().signal);
            } catch (error) {
                if (attempt >= attempts) throw error;
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`Page fetch failed (attempt ${attempt}/${attempts}), retrying: ${message}`);
                await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
            }
        }
    }

    private extractChapterNumber(chapterTitle: string): string {
        // Try to find chapter number patterns
        const patterns = [
            /Ch\.?(\d+(?:\.\d+)?)/i,      // Ch.001, Ch.1, Ch.1.5
            /Chapter\s*(\d+(?:\.\d+)?)/i,  // Chapter 1, Chapter 42.5
            /^(\d+(?:\.\d+)?)/,            // Just a number at the start
            /(\d+(?:\.\d+)?)/              // Any number as fallback
        ];

        for (const pattern of patterns) {
            const match = chapterTitle.match(pattern);
            if (match) {
                // Remove leading zeros and return
                const num = parseFloat(match[1]);
                return num.toString();
            }
        }

        // If no number found, return sanitized version of full title
        return SanitizeFileName(chapterTitle);
    }

    /**
     * Download chapters and create export file
     */
    private async downloadAndExport(downloadId: string, request: DownloadRequest, chapters: any[], mangaTitle: string, downloadPath: string): Promise<string> {
        const storageController = engineService.getStorageController();
        const format = request.format || 'cbz';

        let lastOutputPath = '';
        // Process each chapter
        for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
            const chapter = chapters[chapterIndex];

            logger.info(`Downloading chapter ${chapterIndex + 1}/${chapters.length}: ${chapter.Title}`);
            this.updateDownloadStatus(downloadId, {
                currentChapter: chapter.Title,
                progress: Math.floor((chapterIndex / chapters.length) * 90), // Reserve last 10% for export
            });

            try {
                // Fetch pages for this chapter
                await chapter.Update();
                const pages = chapter.Entries.Value;

                if (pages.length === 0) {
                    logger.warn(`Chapter ${chapter.Title} has no pages, skipping`);
                    continue;
                }

                logger.info(`Fetching ${pages.length} pages for chapter: ${chapter.Title}`);

                // Download all pages and store temporarily
                const resourceMap = new Map<number, string>();
                for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
                    const page = pages[pageIndex];
                    try {
                        logger.debug(`Fetching page ${pageIndex + 1}/${pages.length}: ${page.Link?.href}`);
                        const imageBlob = await this.fetchPageWithRetry(page);
                        logger.debug(`Received blob: type=${imageBlob?.type}, size=${imageBlob?.size}`);

                        const tempKey = await storageController.SaveTemporary(imageBlob);
                        logger.debug(`Saved to temporary storage with key: ${tempKey}`);
                        resourceMap.set(pageIndex, tempKey);

                        // Update progress within chapter
                        const chapterProgress = (chapterIndex + (pageIndex + 1) / pages.length) / chapters.length;
                        this.updateDownloadStatus(downloadId, {
                            progress: Math.floor(chapterProgress * 90),
                        });
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        const errorStack = error instanceof Error ? error.stack : undefined;
                        logger.error(`Failed to download page ${pageIndex + 1} of chapter ${chapter.Title}:`, {
                            error: errorMessage,
                            stack: errorStack,
                            pageLink: page.Link?.href,
                        });
                        throw new Error(`Failed to download page ${pageIndex + 1}: ${errorMessage}`);
                    }
                }

                logger.info(`Successfully downloaded ${resourceMap.size} pages for chapter: ${chapter.Title}`);

                // Create export using appropriate exporter
                // Extract chapter number for clean filename
                const chapterNumber = request.options?.sequentialChapterNames
                    ? String(chapterIndex + 1)
                    : this.extractChapterNumber(chapter.Title);
                // Use clean manga title for folder name instead of manga ID
                const sanitizedMangaTitle = SanitizeFileName(mangaTitle);

                let outputPath: string;
                let exporter;

                if (format === 'cbz') {
                    // Use clean format: berserk/chapter_1.cbz, berserk/chapter_2.cbz, etc.
                    const fileName = `chapter-${chapterNumber}.cbz`;
                    outputPath = path.join(downloadPath, sanitizedMangaTitle, fileName);
                    exporter = new NodeComicBookArchiveExporter(storageController);
                } else if (format === 'images') {
                    // Use clean format: berserk/chapter_1, berserk/chapter_2, etc.
                    const dirName = `chapter-${chapterNumber}`;
                    outputPath = path.join(downloadPath, sanitizedMangaTitle, dirName);
                    exporter = new NodeImageDirectoryExporter(storageController);
                } else {
                    throw new Error(`Unsupported format: ${format}`);
                }

                // Ensure parent directory exists
                await fs.mkdir(path.dirname(outputPath), { recursive: true });

                logger.info(`Exporting to ${format}: ${outputPath}`);

                try {
                    await exporter.Export(resourceMap, outputPath, chapter.Title, mangaTitle);
                    logger.info(`Successfully exported chapter to: ${outputPath}`);
                } finally {
                    // Clean up temporary files
                    const tempKeys = Array.from(resourceMap.values());
                    await storageController.RemoveTemporary(...tempKeys);
                }

                lastOutputPath = outputPath;

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const errorStack = error instanceof Error ? error.stack : undefined;
                logger.error(`Failed to process chapter ${chapter.Title}:`, {
                    error: errorMessage,
                    stack: errorStack,
                    chapterTitle: chapter.Title,
                    chapterId: chapter.Identifier,
                });
                throw error;
            }
        }

        if (!lastOutputPath) throw new Error('No chapters were successfully downloaded');
        return lastOutputPath;
    }

    /**
     * Get all downloads
     */
    public getAllDownloads(): DownloadStatus[] {
        return Array.from(this.downloads.values());
    }

    /**
     * Get a specific download
     */
    public getDownload(downloadId: string): DownloadStatus {
        const download = this.downloads.get(downloadId);
        if (!download) {
            throw Errors.DownloadNotFound(downloadId);
        }
        return download;
    }

    /**
     * Get download file path
     */
    public async getDownloadFilePath(downloadId: string): Promise<string> {
        const download = this.getDownload(downloadId);

        if (download.status !== 'completed') {
            throw Errors.BadRequest('Download is not completed yet');
        }

        // Use manga title for folder name (clean), fallback to manga ID if title not available
        const folderName = download.mangaTitle
            ? SanitizeFileName(download.mangaTitle)
            : SanitizeFileName(download.mangaId);

        // Use custom download path if it was specified, otherwise use default
        const baseDir = download.downloadPath || this.downloadDir;
        const mangaDir = path.join(baseDir, folderName);

        // Check if manga directory exists
        try {
            await fs.access(mangaDir);
        } catch {
            logger.warn(`Manga directory not found for download ${downloadId}: ${mangaDir}`);
            throw Errors.NotFound('Download file');
        }

        // List all files/directories in the manga directory
        const entries = await fs.readdir(mangaDir, { withFileTypes: true });

        if (entries.length === 0) {
            logger.warn(`Manga directory is empty for download ${downloadId}: ${mangaDir}`);
            throw Errors.NotFound('Download file');
        }

        if (entries.length > 1) return mangaDir;

        const entry = entries[0];
        const filePath = path.join(mangaDir, entry.name);

        logger.debug(`Found download file: ${filePath}`);
        return filePath;
    }

    /**
     * Delete a download
     */
    public async deleteDownload(downloadId: string): Promise<void> {
        const download = this.getDownload(downloadId);

        // If completed, delete the file
        if (download.status === 'completed') {
            try {
                const filePath = await this.getDownloadFilePath(downloadId);
                const stats = await fs.stat(filePath);
                if (stats.isDirectory()) {
                    await fs.rm(filePath, { recursive: true, force: true });
                } else {
                    await fs.unlink(filePath);
                }
            } catch (error) {
                logger.warn(`Failed to delete file for download ${downloadId}:`, error);
            }
        }

        // Remove from map
        this.downloads.delete(downloadId);
    }

    /**
     * Update download status
     */
    private updateDownloadStatus(
        downloadId: string,
        updates: Partial<DownloadStatus>
    ): void {
        const download = this.downloads.get(downloadId);
        if (download) {
            Object.assign(download, updates, {
                updatedAt: new Date().toISOString(),
            });
            this.downloads.set(downloadId, download);
        }
    }

    /**
     * Cleanup old downloads
     */
    public async cleanupOldDownloads(): Promise<void> {
        const retentionMs = config.downloads.retentionDays * 24 * 60 * 60 * 1000;
        const now = Date.now();

        const entries = Array.from(this.downloads.entries());
        for (const [id, download] of entries) {
            const createdAt = new Date(download.createdAt).getTime();

            if (now - createdAt > retentionMs) {
                await this.deleteDownload(id);
            }
        }
    }
}

// Export singleton instance
export const downloadService = new DownloadService();
