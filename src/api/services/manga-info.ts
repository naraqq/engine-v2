import { FetchWindowScript } from '../../engine/platform/FetchProvider.js';

/** What a series page says about itself (best effort, any site). */
export interface MangaPageInfo {
    url: string;
    title: string;
    description: string;
    cover: string;
    genres: string[];
    status: string;
    author: string;
    alternative: string;
}

/**
 * Runs in the series page (real browser, so Cloudflare and lazy content are
 * handled). Generic on purpose: OpenGraph / JSON-LD first, then the layouts
 * of common reader sites (Madara/WordPress, Asura, WeebCentral…), then
 * "Label: value" rows. Fields it can't find come back empty.
 */
const INFO_SCRIPT = `
    new Promise(resolve => {
        const clean = s => String(s || '').replace(/\\s+/g, ' ').trim();
        const text = el => clean(el && el.textContent);
        const meta = name => clean(document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]')?.getAttribute('content'));
        const imgUrl = img => img && (img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || img.currentSrc || img.getAttribute('src'));

        // Structured data, when the site provides it.
        let ld = {};
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const json = JSON.parse(script.textContent);
                const items = Array.isArray(json) ? json : (json['@graph'] || [json]);
                for (const item of items) {
                    if (item && (item.description || item.image) && !/BreadcrumbList|Organization|WebSite/.test(String(item['@type']))) ld = Object.assign({}, item, ld);
                }
            } catch (e) { /* ignore broken JSON-LD */ }
        }

        // Synopsis: the longest sensible block among known containers.
        const descSelectors = ['.summary__content', '.description-summary', '.manga-excerpt', '[itemprop="description"]',
            '#description', '.series-synopsis', '.synopsis', '.summary', 'p.whitespace-pre-wrap', '.prose p', 'section p'];
        let description = '';
        for (const sel of descSelectors) {
            for (const el of document.querySelectorAll(sel)) {
                const t = text(el);
                if (t.length > description.length && t.length >= 60 && t.length < 4000) description = t;
            }
            if (description.length >= 120) break;
        }
        if (!description) description = clean(typeof ld.description === 'string' ? ld.description : '') || meta('og:description') || meta('description');

        // Poster: the biggest portrait-shaped image on the page (og:image is
        // often a landscape social card with the site's branding), preferring
        // one whose alt text matches the title.
        const pageTitle = clean(document.querySelector('h1')?.textContent || meta('og:title')).toLowerCase();
        const words = pageTitle.split(/\\W+/).filter(w => w.length > 2);
        const inNav = el => !!el.closest('nav, header, footer, aside, .menu, .sidebar, .widget, [class*="related"], [class*="recommend"]');
        // This series' slug/ID from the URL ("the-indomitable-martial-king-f212c582"
        // also matches without its "-f212c582" suffix). Poster files are
        // usually named after it, unlike the other series' covers around it.
        const ids = location.pathname.split('/').filter(s => s.length >= 6 && !/^(manga|comics|series|title|webtoon)$/i.test(s))
            .flatMap(s => [s.toLowerCase(), s.toLowerCase().replace(/-[0-9a-f]{6,10}$/, '')]);
        const matchesSeries = u => ids.some(id => id.length >= 6 && u.toLowerCase().includes(id));
        let best = null;
        const consider = (u, w, h, el) => {
            if (!u || /logo|avatar|icon|favicon|ads?\\//i.test(u) || (el && inNav(el))) return;
            const own = matchesSeries(u);
            // The series' own poster slot (WordPress manga themes): beats a bigger
            // cover of another series in a "popular" list beside it. Often lazy-loaded,
            // so its size comes from the HTML attributes, and it skips the size check.
            const slot = el && el.closest && el.closest('[itemprop="image"], .thumb, .summary_image, .series-thumb, .infomanga .thumb') ? 30 : 1;
            if (el && !w) { w = Number(el.getAttribute('width')) || 0; h = Number(el.getAttribute('height')) || 0; }
            const ratio = w && h ? h / w : 0;
            // A landscape image is a banner, even when named after the series (Asura's /banners/<slug>).
            if (ratio && ratio < 1) return;
            if (!own && slot === 1 && (w < 150 || h < 200 || ratio < 1.15 || ratio > 1.9)) return;
            const alt = ((el && el.alt) || '').toLowerCase();
            const score = slot * (own ? 50 : 1) * (words.some(word => alt.includes(word)) ? 4 : 1)
                * (ratio >= 1.15 && ratio <= 1.9 ? 3 : 1) * Math.max(w * h, slot > 1 ? 120_000 : 1);
            if (!best || score > best.score) best = { u, score };
        };
        for (const img of document.images) consider(imgUrl(img), img.naturalWidth, img.naturalHeight, img);
        for (const source of document.querySelectorAll('picture source[srcset]')) {
            consider(source.getAttribute('srcset').split(',')[0].trim().split(' ')[0], 0, 0, source.parentElement?.querySelector('img'));
        }
        // A poster marked up as the page's own image (schema.org itemprop) wins
        // outright: lazy loading and ad slots make the size-based pick unstable.
        const marked = [...document.querySelectorAll('img[itemprop="image"], [itemprop="image"] img')]
            .find(img => !inNav(img) && imgUrl(img) && !/logo|avatar|icon/i.test(imgUrl(img)));
        let cover = marked ? imgUrl(marked) : best ? best.u : '';
        cover = cover || meta('og:image') || (typeof ld.image === 'string' ? ld.image : (ld.image && ld.image.url) || '');

        // Genres / tags: the series' own list. Known containers are tried one
        // at a time; generic link searches skip menus, which on many sites
        // list every genre of the site.
        const junk = t => !t || t.length >= 30 || /^(genres?|tags?|home|read (first|last))$/i.test(t)
            || /^(chapter|episode|ch\\.)\\s*\\d/i.test(t) || /^\\d{4}$/.test(t) || t.toLowerCase() === pageTitle;
        const genreLinks = sel => [...document.querySelectorAll(sel)].filter(a => !inNav(a)).map(text).filter(t => !junk(t));
        let genres = [];
        for (const sel of ['.genres-content a', '.wp-manga-tags-list a', '.mgen a', 'a[href*="included_tag"]',
            'a[href*="genres="]', 'a[href*="/genre/"]', 'a[href*="/genres/"]', 'a[href*="/tag/"]']) {
            genres = genreLinks(sel);
            if (genres.length) break;
        }
        genres = [...new Set(genres)].slice(0, 20);

        // "Label: value" rows (status, author, alternative titles).
        const labelled = re => {
            for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,dt,th,strong,b,span,div,li')) {
                if (el.children.length > 3) continue;
                const t = text(el);
                if (t.length > 160 || !re.test(t)) continue;
                const inline = clean(t.replace(re, '').replace(/^[\\s:：\\-–]+/, ''));
                if (inline && inline.length < 140) return inline;
                const next = el.nextElementSibling || el.parentElement?.nextElementSibling;
                const v = text(next);
                if (v && v.length < 140) return v;
            }
            return '';
        };

        resolve({
            url: location.href,
            title: clean(document.querySelector('h1')?.textContent) || meta('og:title'),
            description,
            cover: cover ? new URL(cover, location.href).href : '',
            genres,
            status: labelled(/^status\\b/i),
            author: labelled(/^(author\\(s\\)|authors?|artists?)(?![a-z])/i),
            alternative: labelled(/^(alternative|alternative titles?|alt\\.? titles?|associated names?|other names?)\\b/i),
        });
    });
`;

export async function fetchMangaPageInfo(url: string): Promise<MangaPageInfo> {
    return FetchWindowScript<MangaPageInfo>(new Request(url), INFO_SCRIPT, 1500);
}
