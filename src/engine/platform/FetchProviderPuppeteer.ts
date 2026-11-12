import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { type Browser, type Page } from 'puppeteer';
import { JSDOM, VirtualConsole } from 'jsdom';
import { ProxyAgent } from 'undici';
import { FetchProvider, type ScriptInjection } from './FetchProviderCommon.js';
import { config } from '../../config/settings.js';
import { logger } from '../../config/logger.js';
import { CheckAntiScrapingDetection, FetchRedirection } from './AntiScrapingDetection.js';

// Apply stealth plugin to bypass Cloudflare bot detection
puppeteer.use(StealthPlugin());

/**
 * Puppeteer-based fetch provider for server-side environments
 * Replaces NW.js/Electron browser windows for Cloudflare handling
 */
export class FetchProviderPuppeteer extends FetchProvider {
    private browser: Browser | null = null;
    private browserPool: Page[] = [];
    private readonly maxBrowsers = config.puppeteer.maxBrowsers;
    private proxyAgent: ProxyAgent | undefined;

    constructor() {
        super();
        // Initialize proxy agent if proxy environment variable is set
        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
        if (proxyUrl) {
            logger.info(`🌐 Configuring proxy: ${proxyUrl.split('@')[proxyUrl.split('@').length - 1]}`);
            this.proxyAgent = new ProxyAgent({ uri: proxyUrl });
        }
    }

    /**
     * Sanitize response headers to remove invalid characters
     * Cloudflare server-timing headers often contain newlines which are invalid in HTTP headers
     */
    private sanitizeHeaders(headers: Headers | Record<string, string>): HeadersInit {
        const sanitizedHeaders: Record<string, string> = {};
        const entries = headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers);

        for (const [key, value] of entries) {
            // Replace newlines and carriage returns with commas to preserve multi-value headers
            const sanitizedValue = value.replace(/[\r\n]+/g, ', ');
            // Only include headers with valid values (no control characters)
            if (!/[\x00-\x1F\x7F]/.test(sanitizedValue)) {
                sanitizedHeaders[key] = sanitizedValue;
            }
        }

        return sanitizedHeaders;
    }

    /**
     * Initialize browser instance
     */
    private async getBrowser(): Promise<Browser> {
        if (!this.browser || !this.browser.connected) {
            try {
                logger.info('🌐 Launching Puppeteer browser...');
                this.browser = await puppeteer.launch({
                    headless: config.puppeteer.headless,
                    executablePath: config.puppeteer.executablePath,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--no-first-run',
                        '--no-zygote',
                    ],
                });
                logger.info('✅ Puppeteer browser launched');
            } catch (error) {
                logger.error('❌ Failed to launch Puppeteer browser:', error);
                logger.error('💡 Solution: Install Chromium/Chrome or set PUPPETEER_EXECUTABLE_PATH');
                logger.error('📖 See PUPPETEER_SETUP.md for detailed instructions');
                throw new Error(
                    'Failed to launch browser. Please install Chromium/Chrome or set PUPPETEER_EXECUTABLE_PATH environment variable. See PUPPETEER_SETUP.md for instructions.'
                );
            }
        }
        return this.browser;
    }

    /**
     * Get a page from the pool or create a new one
     */
    private async getPage(): Promise<Page> {
        // Try to get an available page from the pool
        const availablePage = this.browserPool.pop();
        if (availablePage) {
            return availablePage;
        }

        // Create new page if under limit
        if (this.browserPool.length < this.maxBrowsers) {
            const browser = await this.getBrowser();
            const page = await browser.newPage();

            // Set realistic viewport - stealth plugin handles user-agent and other fingerprints
            await page.setViewport({
                width: 1920,
                height: 1080
            });

            return page;
        }

        // Wait and retry if pool is full
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.getPage();
    }

    /**
     * Return page to pool
     */
    private async releasePage(page: Page): Promise<void> {
        try {
            // Clear cookies and cache
            await page.evaluate(() => {
                localStorage.clear();
                sessionStorage.clear();
            });

            if (this.browserPool.length < this.maxBrowsers) {
                this.browserPool.push(page);
            } else {
                await page.close();
            }
        } catch (error) {
            logger.error('Error releasing page:', error);
            await page.close().catch(() => {});
        }
    }

    /**
     * Standard fetch implementation
     */
    public async Fetch(request: Request): Promise<Response> {
        // Try standard fetch first
        try {
            // Use proxy agent if configured
            const fetchOptions = (this.proxyAgent ? { dispatcher: this.proxyAgent } : {}) as RequestInit;
            const response = await fetch(request, fetchOptions);
            await this.ValidateResponse(response);

            // Sanitize response headers to fix Cloudflare server-timing headers with newlines
            const sanitizedHeaders = this.sanitizeHeaders(response.headers);
            const body = await response.arrayBuffer();

            return new Response(body, {
                status: response.status,
                statusText: response.statusText,
                headers: sanitizedHeaders
            });
        } catch (error) {
            // If Cloudflare challenge detected, use Puppeteer
            if (error.message?.includes('CloudFlare') || error.message?.includes('Forbidden')) {
                logger.warn(`Cloudflare detected for ${request.url}, using Puppeteer...`);
                return this.FetchWithBrowser(request);
            }
            throw error;
        }
    }

    /**
     * Fetch using Puppeteer browser
     */
    private async FetchWithBrowser(request: Request): Promise<Response> {
        const page = await this.getPage();

        try {
            // For POST/PUT/PATCH requests, we need to handle them differently
            // because page.goto() only supports GET requests
            if (request.method && request.method !== 'GET' && request.method !== 'HEAD') {
                logger.info(`🔄 Handling ${request.method} request with Puppeteer evaluate...`);

                // Extract the referer from headers to navigate to the correct page
                // For WordPress Madara AJAX endpoints, the referer is the manga page
                const referer = request.headers.get('Referer');
                const pageToVisit = referer || new URL(request.url).origin;

                logger.info(`🌐 Navigating to ${pageToVisit} to establish session...`);

                const initialResponse = await page.goto(pageToVisit, {
                    waitUntil: 'domcontentloaded',
                    timeout: config.puppeteer.timeout,
                });

                if (!initialResponse) {
                    throw new Error(`Failed to load ${pageToVisit}`);
                }

                // Wait for Cloudflare challenge on the page
                await this.waitForCloudflare(page);
                logger.info('✅ Cloudflare challenge passed, making POST request...');

                // Now make the actual POST request using fetch within the page context
                const requestHeaders: Record<string, string> = {};
                request.headers.forEach((value, key) => {
                    requestHeaders[key] = value;
                });

                const body = request.body ? await request.text() : undefined;

                const result = await page.evaluate(async (url, method, headers, bodyText) => {
                    const response = await fetch(url, {
                        method,
                        headers,
                        body: bodyText,
                    });

                    return {
                        status: response.status,
                        statusText: response.statusText,
                        headers: Object.fromEntries(response.headers.entries()),
                        body: await response.text(),
                    };
                }, request.url, request.method, requestHeaders, body);

                // Debug logging
                logger.info(`📦 POST response status: ${result.status}`);
                logger.info(`📦 POST response body length: ${result.body.length}`);
                logger.info(`📦 POST response body preview: ${result.body.substring(0, 500)}`);

                // Sanitize headers
                const sanitizedHeaders = this.sanitizeHeaders(result.headers);

                return new Response(result.body, {
                    status: result.status,
                    statusText: result.statusText,
                    headers: sanitizedHeaders,
                });
            }

            // For GET requests, use the standard page.goto approach
            const response = await page.goto(request.url, {
                waitUntil: 'domcontentloaded',
                timeout: config.puppeteer.timeout,
            });

            if (!response) {
                throw new Error(`Failed to load ${request.url}`);
            }

            // Wait for Cloudflare challenge to complete
            await this.waitForCloudflare(page);

            const content = await page.content();
            const headers = response.headers();

            // Sanitize headers to remove invalid characters (e.g., newlines in Cloudflare server-timing)
            const sanitizedHeaders = this.sanitizeHeaders(headers);

            // A cached page comes back as 304, but we always return the rendered
            // HTML, and Response() rejects a body on null-body statuses.
            const status = [101, 103, 204, 205, 304].includes(response.status()) ? 200 : response.status();
            const responseInit: ResponseInit = {
                status,
                statusText: response.statusText(),
                headers: sanitizedHeaders,
            };

            return new Response(content, responseInit);
        } finally {
            await this.releasePage(page);
        }
    }

    /**
     * Wait for Cloudflare challenge to complete
     */
    private async waitForCloudflare(page: Page, maxWaitTime = 45000): Promise<void> {
        const startTime = Date.now();
        let lastTitle = '';

        while (Date.now() - startTime < maxWaitTime) {
            try {
                const pageInfo = await page.evaluate(() => {
                    return {
                        title: document.title,
                        hasChallenge: (
                            document.title.toLowerCase().includes('just a moment') ||
                            document.title.toLowerCase().includes('checking your browser') ||
                            !!document.querySelector('#challenge-running') ||
                            !!document.querySelector('.cf-browser-verification') ||
                            !!document.querySelector('div[class*="cloudflare"]')
                        ),
                        url: window.location.href,
                    };
                });

                // Log page title changes
                if (pageInfo.title !== lastTitle) {
                    logger.info(`📄 Page title: "${pageInfo.title}"`);
                    lastTitle = pageInfo.title;
                }

                if (!pageInfo.hasChallenge) {
                    logger.info('Cloudflare challenge passed');
                    return;
                }
            } catch (error) {
                // Execution context destroyed means page navigated (likely challenge completed)
                if (error.message?.includes('Execution context was destroyed')) {
                    logger.info('Page navigated during challenge check, waiting for navigation to complete...');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    // After navigation completes, check once more
                    try {
                        const stillChallenging = await page.evaluate(() => {
                            return (
                                document.title.toLowerCase().includes('just a moment') ||
                                document.title.toLowerCase().includes('checking your browser')
                            );
                        });
                        if (!stillChallenging) {
                            logger.info('Cloudflare challenge passed after navigation');
                            return;
                        }
                    } catch {
                        // If it errors again, continue the loop
                    }
                } else {
                    throw error;
                }
            }

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        logger.warn('Cloudflare challenge timeout, proceeding anyway...');
    }

    /**
     * Fetch and parse HTML using JSDOM
     */
    public override async FetchHTML(request: Request): Promise<Document> {
        const response = await this.Fetch(request);
        let html = await response.text();

        // Strip out all CSS to prevent JSDOM CSS parsing errors
        // This is necessary because many manga sites have malformed CSS that breaks JSDOM
        // We only need the HTML structure for scraping, not the styles
        html = html
            // Remove <style> tags and their content
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            // Remove inline style attributes
            .replace(/\s+style\s*=\s*["'][^"']*["']/gi, '')
            // Remove <link> tags for stylesheets
            .replace(/<link[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi, '');

        // Create a virtual console that suppresses any remaining errors
        const virtualConsole = new VirtualConsole();
        virtualConsole.on('error', () => {
            // Silently suppress all JSDOM errors
        });

        // Use JSDOM to create a DOM
        const dom = new JSDOM(html, {
            url: request.url,
            contentType: 'text/html',
            virtualConsole,
        });

        return dom.window.document;
    }

    /**
     * Execute script in browser window (replaces FetchWindowScript)
     */
    public override async FetchWindowScript<T extends void | JSONElement>(
        request: Request,
        script: ScriptInjection<T>,
        delay = 0,
        timeout = 60000
    ): Promise<T> {
        return this.FetchWindowPreloadScript<T>(request, () => undefined, script, delay, timeout);
    }

    /**
     * Execute script in browser window with preload script
     */
    public override async FetchWindowPreloadScript<T extends void | JSONElement>(
        request: Request,
        preload: ScriptInjection<void>,
        script: ScriptInjection<T>,
        delay = 0,
        timeout = 60000
    ): Promise<T> {
        const page = await this.getPage();

        try {
            // Evaluate preload script
            if (preload) {
                await page.evaluateOnNewDocument(preload as () => void);
            }

            // Navigate to URL
            const response = await page.goto(request.url, {
                waitUntil: 'domcontentloaded',
                timeout,
            });

            if (!response) {
                throw new Error(`Failed to load ${request.url}`);
            }

            // Check for anti-scraping
            const hasChallenge = await page.evaluate(() => {
                return (
                    document.title.toLowerCase().includes('just a moment') ||
                    document.title.toLowerCase().includes('checking your browser') ||
                    !!document.querySelector('form[name="fcaptcha"]') ||
                    !!document.querySelector('#challenge-running')
                );
            });

            if (hasChallenge) {
                logger.warn(`Anti-scraping challenge detected for ${request.url}`);
                // Wait for challenge to complete
                await this.waitForCloudflare(page, timeout);
            }

            // Wait for delay
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            // Execute main script
            const result = await page.evaluate(script as () => Promise<T>);

            return result;
        } finally {
            await this.releasePage(page);
        }
    }

    /**
     * Cleanup browser resources
     */
    public async cleanup(): Promise<void> {
        logger.info('🧹 Cleaning up Puppeteer resources...');

        // Close all pages in pool
        await Promise.all(this.browserPool.map(page => page.close().catch(() => {})));
        this.browserPool = [];

        // Close browser
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }

        logger.info('✅ Puppeteer cleanup complete');
    }
}
