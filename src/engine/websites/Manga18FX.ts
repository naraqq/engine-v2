import { Tags } from '../Tags';
import icon from './Manga18FX.webp';
import { FetchCSS } from '../platform/FetchProvider';
import { DecoratableMangaScraper, Manga, type MangaPlugin } from '../providers/MangaPlugin';
import * as Madara from './decorators/WordPressMadara';
import * as Common from './decorators/Common';

@Madara.MangaCSS(/^{origin}\/manga\/[^/]+$/, 'div.post-title')
@Madara.MangasMultiPageCSS('div.bixbox div.listupd div.bigor-manga h3 a', 0, '/page/{page}')
@Madara.ChaptersSinglePageCSS('div#chapterlist ul li a.chapter-name')
@Madara.PagesSinglePageCSS()
@Common.ImageAjax()
export default class extends DecoratableMangaScraper {

    public constructor() {
        super('manga18fx', 'Manga18fx', 'https://manga18fx.com', Tags.Media.Manhua, Tags.Media.Manga, Tags.Media.Manhwa, Tags.Language.Multilingual, Tags.Rating.Erotica);
    }

    public override get Icon() {
        return icon;
    }

    /** The site's own search (/search?q=), instead of crawling every catalog page. */
    public async SearchMangas(provider: MangaPlugin, query: string): Promise<Manga[]> {
        const url = new URL('/search', this.URI);
        url.searchParams.set('q', query);
        const anchors = await FetchCSS<HTMLAnchorElement>(new Request(url), 'a[href^="/manga/"][title]');
        const seen = new Set<string>();
        return anchors
            .map(anchor => ({ slug: new URL(anchor.getAttribute('href'), this.URI).pathname.replace(/\/$/, ''), title: anchor.title.trim() }))
            .filter(({ slug, title }) => /^\/manga\/[^/]+$/.test(slug) && title && !seen.has(slug) && seen.add(slug))
            // Same identifier shape as the rest of this (Madara) connector.
            .map(({ slug, title }) => new Manga(this, provider, JSON.stringify({ post: '', slug }), title));
    }
}
