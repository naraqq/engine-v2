const baseUrl = (process.env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const sourceId = process.argv[2];

if (!sourceId || !/^[a-z0-9][a-z0-9_-]*$/i.test(sourceId)) {
    console.error('Usage: npm run download -- <website-id>');
    console.error('Example: npm run download -- asurascans');
    process.exit(1);
}

try {
    const response = await fetch(`${baseUrl}/api/v1/downloads/trending`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            sourceId,
            titleLimit: 10,
            chapterLimit: 5,
            format: 'images',
        }),
    });

    const payload = await response.json();
    if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message || `HTTP ${response.status}`);
    }

    const downloads = payload.data?.downloads || [];
    console.log(`Queued ${downloads.length} titles from ${sourceId} (up to 5 chapters each).`);
    for (const download of downloads) {
        console.log(`- ${download.mangaTitle || download.mangaId}: ${download.id}`);
    }
} catch (error) {
    const cause = error.cause?.message ? ` (${error.cause.message})` : '';
    console.error(`Could not queue trending downloads: ${error.message}${cause}`);
    console.error(`Make sure the service is running at ${baseUrl}.`);
    process.exitCode = 1;
}
