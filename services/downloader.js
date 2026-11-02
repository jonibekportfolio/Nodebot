const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const https = require('https');
const axios = require('axios');
const { youtube, fbdown, igdl } = require('btch-downloader');

// Doimiy Keep-Alive ulanish
const keepAliveAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    timeout: 10000
});

const fastAxios = axios.create({
    httpsAgent: keepAliveAgent,
    timeout: 8000
});

// Keshlash tizimi
const videoCache = new Map();
const audioCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 daqiqa

function saveAudioInfo(id, data) {
    audioCache.set(id, {
        ...data,
        timestamp: Date.now()
    });
    if (audioCache.size > 500) {
        const now = Date.now();
        for (const [k, v] of audioCache.entries()) {
            if (now - v.timestamp > 3600000) audioCache.delete(k);
        }
    }
}

function getAudioInfo(id) {
    return audioCache.get(id) || null;
}

/**
 * YouTube Video ID ajratib olish
 */
function extractYouTubeId(url) {
    if (!url) return null;
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([a-zA-Z0-9_-]{11})/i);
    return match ? match[1] : null;
}

/**
 * Instagram Shortcode ajratib olish
 */
function extractInstagramShortcode(url) {
    if (!url) return null;
    const match = url.match(/instagram\.com\/(?:[a-zA-Z0-9_.]+\/)?(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/i);
    return match ? match[1] : null;
}

function extractEscapedField(html, key) {
    const marker = `\\"${key}\\":\\"`;
    const idx = html.indexOf(marker);
    if (idx === -1) return null;
    const start = idx + marker.length;
    const end = html.indexOf('\\"', start);
    if (end === -1) return null;
    return html.slice(start, end);
}

function extractEscapedNumber(html, marker) {
    const idx = html.indexOf(marker);
    if (idx === -1) return 0;
    const sub = html.slice(idx + marker.length, idx + marker.length + 30);
    const m = sub.match(/^(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
}

/**
 * 1. INSTAGRAM VIDEO YUKLAB OLISH
 */
async function fetchFromInstagramEmbed(shortcode, skipCache = false) {
    if (!skipCache && videoCache.has(`ig_${shortcode}`)) {
        const cached = videoCache.get(`ig_${shortcode}`);
        if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
            return cached.data;
        }
    }

    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await fastAxios.get(embedUrl);
            const html = response.data || '';
            const rawVideoUrl = extractEscapedField(html, 'video_url');
            if (!rawVideoUrl) continue;

            const cleanVideoUrl = rawVideoUrl
                .replace(/\\\\\//g, '/')
                .replace(/\\\//g, '/')
                .replace(/\\u00253D/g, '%3D')
                .replace(/\\u0026/g, '&')
                .replace(/&amp;/g, '&');

            const author = extractEscapedField(html, 'username') || 'instagram';
            const views = Math.round(extractEscapedNumber(html, '\\"video_view_count\\":'));
            const likes = Math.round(extractEscapedNumber(html, '\\"edge_liked_by\\":{\\"count\\":'));
            const followers = Math.round(extractEscapedNumber(html, '\\"edge_followed_by\\":{\\"count\\":'));
            const song = extractEscapedField(html, 'song_name');
            const artist = extractEscapedField(html, 'artist_name');
            const music = (artist && song) ? `${artist} - ${song}` : '';

            const audioId = `ig_${shortcode}`;
            saveAudioInfo(audioId, {
                audioUrl: cleanVideoUrl,
                title: music || `Instagram Audio (${shortcode})`,
                performer: author ? `@${author}` : 'Instagram'
            });

            const result = {
                success: true,
                platform: 'instagram',
                audioId,
                shortcode,
                videoUrl: cleanVideoUrl,
                audioUrl: cleanVideoUrl,
                author,
                views,
                likes,
                followers,
                music
            };

            videoCache.set(`ig_${shortcode}`, { timestamp: Date.now(), data: result });
            return result;
        } catch (err) {
            console.warn(`[Instagram Embed attempt ${attempt}]:`, err.message);
        }
    }
    return null;
}

async function downloadInstagramVideo(url) {
    try {
        const shortcode = extractInstagramShortcode(url);
        if (shortcode) {
            const embedData = await fetchFromInstagramEmbed(shortcode);
            if (embedData && embedData.videoUrl) return embedData;
        }

        // Fallback: igdl
        const fallback = await igdl(url);
        if (fallback && fallback.result && fallback.result.length > 0 && fallback.result[0].url) {
            const videoUrl = fallback.result[0].url;
            const audioId = `ig_${shortcode || Math.random().toString(36).substring(2, 8)}`;
            saveAudioInfo(audioId, {
                audioUrl: videoUrl,
                title: 'Instagram Audio',
                performer: 'Instagram'
            });
            return {
                success: true,
                platform: 'instagram',
                audioId,
                shortcode: shortcode || audioId,
                videoUrl,
                audioUrl: videoUrl,
                author: 'Instagram',
                views: 0,
                likes: 0,
                music: ''
            };
        }

        return { success: false, error: 'Instagram videoni yuklab bo\'lmadi' };
    } catch (error) {
        console.error('[IG Downloader Error]:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * 2. YOUTUBE VIDEO YUKLAB OLISH (Video + MP3)
 */
async function downloadYouTubeVideo(url) {
    try {
        const ytId = extractYouTubeId(url);
        const cacheKey = `yt_${ytId || url}`;
        if (videoCache.has(cacheKey)) {
            const cached = videoCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
                return cached.data;
            }
        }

        let targetUrl = url;
        if (ytId) {
            targetUrl = `https://www.youtube.com/watch?v=${ytId}`;
        }

        const res = await youtube(targetUrl);
        if (!res || !res.status || !res.mp4) {
            return { success: false, error: 'YouTube videoni yuklab bo\'lmadi' };
        }

        const audioId = `yt_${ytId || Math.random().toString(36).substring(2, 8)}`;
        const title = res.title || 'YouTube Video';
        const author = res.author || 'YouTube';
        const audioUrl = res.mp3 || res.mp4;

        saveAudioInfo(audioId, {
            audioUrl,
            title,
            performer: author
        });

        const data = {
            success: true,
            platform: 'youtube',
            audioId,
            videoUrl: res.mp4,
            audioUrl,
            title,
            author,
            thumbnail: res.thumbnail || null
        };

        videoCache.set(cacheKey, { timestamp: Date.now(), data });
        return data;
    } catch (error) {
        console.error('[YouTube Downloader Error]:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * 3. FACEBOOK VIDEO YUKLAB OLISH (HD / SD)
 */
async function downloadFacebookVideo(url) {
    try {
        const cacheKey = `fb_${url}`;
        if (videoCache.has(cacheKey)) {
            const cached = videoCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
                return cached.data;
            }
        }

        const res = await fbdown(url);
        const videoUrl = (res && (res.HD || res.Normal_video)) || null;

        if (!videoUrl) {
            return { success: false, error: 'Facebook videoni yuklab bo\'lmadi' };
        }

        const audioId = `fb_${Math.random().toString(36).substring(2, 8)}`;
        saveAudioInfo(audioId, {
            audioUrl: res.Normal_video || res.HD,
            title: 'Facebook Audio',
            performer: 'Facebook'
        });

        const data = {
            success: true,
            platform: 'facebook',
            audioId,
            videoUrl,
            audioUrl: res.Normal_video || res.HD,
            title: 'Facebook Video',
            author: 'Facebook'
        };

        videoCache.set(cacheKey, { timestamp: Date.now(), data });
        return data;
    } catch (error) {
        console.error('[Facebook Downloader Error]:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * 4. UNIVERSAL VIDEO YUKLOVCHI (Platformani avtomatik aniqlaydi)
 */
async function downloadUniversalVideo(url) {
    if (!url || typeof url !== 'string') return { success: false, error: 'Havola kiritilmadi' };

    const lower = url.toLowerCase();
    if (lower.includes('instagram.com') || lower.includes('instagr.am')) {
        return await downloadInstagramVideo(url);
    } else if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
        return await downloadYouTubeVideo(url);
    } else if (lower.includes('facebook.com') || lower.includes('fb.watch') || lower.includes('fb.com')) {
        return await downloadFacebookVideo(url);
    }
    return { success: false, error: 'Qo\'llab-quvvatlanmaydigan havola' };
}

module.exports = {
    downloadInstagramVideo,
    downloadYouTubeVideo,
    downloadFacebookVideo,
    downloadUniversalVideo,
    fetchFromInstagramEmbed,
    extractInstagramShortcode,
    extractYouTubeId,
    getAudioInfo,
    saveAudioInfo
};
