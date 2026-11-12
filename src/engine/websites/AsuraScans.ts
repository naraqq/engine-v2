import { FetchWindowScript } from '../platform/FetchProvider';
import { DecoratableMangaScraper, Manga, type MangaPlugin } from '../providers/MangaPlugin';
import { Tags } from '../Tags';
import icon from './AsuraScans.webp';
import * as Common from './decorators/Common';
import * as MangaStream from './decorators/WordPressMangaStream';

const excludes = [
    /panda_gif_large/i,
    /2021\/04\/page100-10\.jpg/i,
    /2021\/03\/20-ending-page-\.jpg/i,
    /ENDING-PAGE/i,
    /EndDesignPSD/i
];

// Chapter link text now runs the number into the release date
// ("Chapter 1271 day ago"), and a "First Chapter" button links to chapter 1,
// so take the number from the URL instead. Only this series' chapters count;
// newest first, like the site.
const chapterScript = `
    new Promise( resolve => {
        const base = location.pathname.replace(/\\/$/, '') + '/chapter/';
        const chapters = new Map();
        for (const link of document.querySelectorAll('a[href*="/chapter/"]')) {
            const path = link.pathname.replace(/\\/$/, '');
            const match = path.startsWith(base) && path.slice(base.length).match(/^(\\d+(?:\\.\\d+)?)$/);
            if (!match || chapters.has(path)) continue;
            chapters.set(path, { id: path, title: 'Chapter ' + match[1], number: parseFloat(match[1]) });
        }
        resolve([...chapters.values()]
            .sort((a, b) => b.number - a.number)
            .map(({ id, title }) => ({ id, title })));
    });
`;

const pagesScript = `[...document.querySelectorAll('img[alt^="Page "]')].map(image => image.currentSrc || image.src);`;

const trendingScript = `
    new Promise(resolve => {
        const headings = [...document.querySelectorAll('h1, h2, h3')];
        const start = headings.find(node => node.textContent.trim() === 'Trending Comics');
        const end = headings.find(node =>
            start &&
            (start.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            ['Trending Novels', 'Latest Updates'].includes(node.textContent.trim())
        );
        if (!start) return resolve([]);

        const seen = new Set();
        const entries = [...document.querySelectorAll('a[href*="/comics/"]')]
            .filter(anchor => start.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)
            .filter(anchor => !end || (anchor.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING))
            .map(anchor => {
                const image = anchor.querySelector('img[alt]');
                const heading = anchor.querySelector('h2, h3, h4');
                const raw = image?.alt || heading?.textContent || anchor.textContent;
                return { id: anchor.pathname, title: raw.replace(/\\s*Chapter\\s+.*$/i, '').trim() };
            })
            .filter(entry => entry.title && !seen.has(entry.id) && seen.add(entry.id));
        resolve(entries);
    });
`;

const searchScript = `
    new Promise(resolve => {
        const seen = new Set();
        resolve([...document.querySelectorAll('a[href^="/comics/"]')]
            .filter(anchor => /^\\/comics\\/[^/]+$/.test(anchor.pathname))
            .map(anchor => ({
                id: anchor.pathname,
                title: (anchor.querySelector('img[alt]')?.getAttribute('alt') || anchor.textContent).replace(/\\s+/g, ' ').trim(),
            }))
            .filter(entry => entry.title && !seen.has(entry.id) && seen.add(entry.id)));
    });
`;

function MangaLinkExtractor(title: HTMLTitleElement, uri: URL) {
    return {
        id: uri.pathname,
        // jsdom (server side) has no innerText.
        title: (title.textContent ?? '').replace(/\s*\|\s*Asura Scans.*$/i, '').trim(),
    };
}

function MangaInfoExtractor(anchor: HTMLAnchorElement) {
    return {
        id: anchor.pathname,
        title: (anchor.querySelector('img[alt]')?.getAttribute('alt') || anchor.textContent).trim()
    };
}

@Common.MangaCSS(/^{origin}\/comics\/[^/]+$/, 'head title', MangaLinkExtractor)
@Common.MangasMultiPageCSS('a[href*="/comics/"]', Common.PatternLinkGenerator('/comics?page={page}'), 0, MangaInfoExtractor)
@Common.ChaptersSinglePageJS(chapterScript, 500)
@MangaStream.PagesSinglePageJS(excludes, pagesScript, 1000)
@Common.ImageAjax(true)
export default class extends DecoratableMangaScraper {

    public constructor() {
        super('asurascans', 'Asura Scans', 'https://asurascans.com', Tags.Media.Manhwa, Tags.Media.Manhua, Tags.Language.English, Tags.Source.Scanlator);
    }

    public override get Icon() {
        return icon;
    }

    /** The site's own search (/browse?search=), matching titles and descriptions. */
    public async SearchMangas(provider: MangaPlugin, query: string): Promise<Manga[]> {
        const url = new URL('/browse', this.URI);
        url.searchParams.set('search', query);
        const entries = await FetchWindowScript<Array<{ id: string; title: string }>>(new Request(url), searchScript, 500);
        return entries.map(entry => new Manga(this, provider, entry.id, entry.title));
    }

    /** Series with the newest chapters (/browse?sort=latest), most recent first. */
    public async FetchLatestMangas(provider: MangaPlugin, limit: number): Promise<Manga[]> {
        const url = new URL('/browse', this.URI);
        url.searchParams.set('sort', 'latest');
        const entries = await FetchWindowScript<Array<{ id: string; title: string }>>(new Request(url), searchScript, 500);
        return entries.slice(0, limit).map(entry => new Manga(this, provider, entry.id, entry.title));
    }

    public async FetchTrendingMangas(provider: MangaPlugin, limit: number): Promise<Manga[]> {
        const entries = await FetchWindowScript<Array<{ id: string; title: string }>>(
            new Request(this.URI),
            trendingScript,
            500
        );
        return entries.slice(0, limit).map(entry => new Manga(this, provider, entry.id, entry.title));
    }

    public override async Initialize(): Promise<void> {
        this.URI.href = await FetchWindowScript<string>(new Request(this.URI), 'window.location.origin');
        console.log(`Assigned URL '${this.URI}' to ${this.Title}`);
    }
}
