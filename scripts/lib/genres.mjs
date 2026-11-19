/**
 * Genres for `download --work --genre drama`: Montoon's genre slugs, and the
 * tags episode sites use for them (their own English names), so a site's
 * series can be matched to a Montoon genre.
 */
import { fail, normalize } from './cli.mjs';
import { mt } from './montoon-api.mjs';

/** Montoon slug → extra source tags meaning the same (the slug itself always counts). */
const SOURCE_TAGS = {
    'sci-fi': ['science fiction', 'sci fi', 'scifi'],
    'slice-of-life': ['slice of life'],
    'martial-arts': ['martial arts', 'murim', 'wuxia', 'cultivation'],
    'sports': ['sport'],
    'shoujo': ['shojo'],
    'shounen': ['shonen'],
    'historical': ['history'],
    'supernatural': ['supernatural'],
    'psychological': ['psychological'],
    'romance': ['romance'],
    'tragedy': ['tragedy'],
    'romcom': ['romantic comedy', 'rom com'],
    'magical-girl': ['magical girls', 'magical girl'],
    'school': ['school life'],
    'mature': ['adult', 'mature', 'smut'],
};

const tagsOf = slug => new Set([normalize(slug.replace(/-/g, ' ')), ...(SOURCE_TAGS[slug] || []).map(normalize)]);

/**
 * The Montoon genre a name means: its slug (drama), English name, Mongolian
 * name (Драма) or ID. Returns { id, slug, name }.
 */
export async function resolveGenre(input) {
    const genres = (await mt('GET', '/genres', undefined, { waitOffline: false })).data;
    if (genres.length && !genres.some(g => g.slug)) {
        fail('The Montoon backend does not send genre slugs yet. Deploy it, then run this again.');
    }
    const wanted = String(input).trim();
    const n = normalize(wanted.replace(/-/g, ' '));
    const hit = genres.find(g => String(g.id) === wanted)
        || genres.find(g => g.slug && normalize(g.slug.replace(/-/g, ' ')) === n)
        || genres.find(g => g.name.trim().toLowerCase() === wanted.toLowerCase())
        || genres.find(g => g.slug && tagsOf(g.slug).has(n));
    if (!hit) {
        fail(`Unknown genre "${input}". Montoon has: ${genres.map(g => g.slug || g.name).filter(Boolean).join(', ')}`);
    }
    if (!hit.slug) fail('The Montoon backend doesn\'t send genre slugs yet. Deploy it, then run this again.');
    return hit;
}

/** Whether a site's own genre tags include the genre. */
export function sourceHasGenre(sourceGenres, slug) {
    const wanted = tagsOf(slug);
    return (sourceGenres || []).some(tag => wanted.has(normalize(tag)));
}

/** Whether a Montoon title (sync feed, `genres` = slugs) is in the genre. */
export const titleHasGenre = (title, slug) => (title.genres || []).includes(slug);
