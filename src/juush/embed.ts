/**
 * Link-preview pages for chat unfurlers (Discord, Slack, ...). No imports, so the
 * unit tests can load it without util.ts's MongoClient.
 */
const UNFURL_BOT_RE = /Discordbot|Twitterbot|Slackbot|Slack-ImgProxy|TelegramBot|facebookexternalhit|WhatsApp|Mastodon|Bluesky|redditbot|LinkedInBot|SkypeUriPreview|Iframely|Embedly/i;

export function isUnfurlBot(userAgent: string | undefined): boolean {
    return !!userAgent && UNFURL_BOT_RE.test(userAgent);
}

// Discord's player is reported to fail (and cache the failure) near ~100 MB.
export const EMBED_VIDEO_MAX_BYTES = 80 * 1024 * 1024;
export const EMBED_VIDEO_TYPES: Record<string, true> = { "video/mp4": true, "video/webm": true, "video/quicktime": true };

export interface EmbedMeta {
    siteName: string;
    title: string;
    description?: string;
    image?: string;
    video?: { url: string; type: string };
    pubdate?: string;
}

const escapeHtml = (s: string): string => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const og = (property: string, content: string): string => `<meta property="${property}" content="${escapeHtml(content)}">`;
const named = (name: string, content: string): string => `<meta name="${name}" content="${escapeHtml(content)}">`;

export function renderEmbedHtml(m: EmbedMeta): string {
    const tags = [
        og("og:site_name", m.siteName),
        og("og:title", m.title),
    ];
    if (m.description) tags.push(og("og:description", m.description));
    if (m.pubdate) tags.push(og("og:pubdate", m.pubdate));
    tags.push(named("theme-color", "#5b8def"));
    if (m.video) {
        tags.push(og("og:type", "video.other"), og("og:video", m.video.url), og("og:video:type", m.video.type));
        if (m.image) tags.push(og("og:image", m.image));
    } else if (m.image) {
        tags.push(og("og:image", m.image), named("twitter:card", "summary_large_image"));
    }
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(m.title)}</title>${tags.join("")}</head><body></body></html>`;
}
