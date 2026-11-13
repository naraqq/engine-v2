import { Tags } from '../Tags';
import icon from './WeebCentral.webp';
import { Chapter, DecoratableMangaScraper, Manga, type MangaPlugin } from '../providers/MangaPlugin';
import * as Common from './decorators/Common';
import { FetchCSS } from '../platform/FetchProvider';

function MangaLinkExtractor(meta: HTMLMetaElement, uri: URL) {
    return {
        id: uri.pathname,
        title: meta.content.split('|').shift().trim(),
    };
}

const pageScript = `[...document.querySelectorAll('main section img[alt*="Page"]:not([x-show]')].map(image => new URL(image.getAttribute('src'), window.location.origin).href);`;

@Common.MangaCSS(/^{origin}\/series\/[^/]+\/[^/]+$/, 'meta[property="og:title"]', MangaLinkExtractor)
@Common.MangasMultiPageCSS('article > a.link', Common.PatternLinkGenerator(`/search/data?display_mode=Minimal+Display&limit=32&offset={page}`, 0, 32), 0)
@Common.PagesSinglePageJS(pageScript, 1500)
@Common.ImageAjax()
export default class extends DecoratableMangaScraper {

    public constructor() {
        super('weebcentral', 'WeebCentral', 'https://weebcentral.com', Tags.Media.Manhwa, Tags.Media.Manhua, Tags.Media.Manga, Tags.Language.English, Tags.Source.Aggregator);
    }

    public override get Icon() {
        return icon;
    }

    /** The site's own search (server-rendered results), instead of crawling the whole catalog. */
    public async SearchMangas(provider: MangaPlugin, query: string): Promise<Manga[]> {
        const url = new URL('/search/data', this.URI);
        url.search = new URLSearchParams({
            text: query, sort: 'Best Match', order: 'Descending', official: 'Any', anime: 'Any', adult: 'Any',
            display_mode: 'Minimal Display', limit: '32', offset: '0',
        }).toString();
        const anchors = await FetchCSS<HTMLAnchorElement>(new Request(url), 'a.link[data-tip][href*="/series/"]');
        const seen = new Set<string>();
        return anchors
            .map(anchor => ({ id: new URL(anchor.href, this.URI).pathname, title: anchor.dataset.tip?.trim() ?? anchor.textContent.trim() }))
            .filter(({ id, title }) => /^\/series\/[^/]+\/[^/]+$/.test(id) && title && !seen.has(id) && seen.add(id))
            .map(({ id, title }) => new Manga(this, provider, id, title));
    }

    public override async FetchChapters(manga: Manga): Promise<Chapter[]> {
        const serieId = manga.Identifier.match(/(\/series\/[^/]+)\//).at(-1);
        const data = await FetchCSS<HTMLAnchorElement>(new Request(new URL(`${serieId}/full-chapter-list`, this.URI)), 'a[href*="/chapters/"]');
        return data.map(chapter => new Chapter(this, manga, chapter.pathname, chapter.querySelector<HTMLSpanElement>('span.grow span').textContent.trim()));
    }
}