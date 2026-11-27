import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { fileURLToPath } from 'url';
import gplay from 'google-play-scraper';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WATCHLIST_PATH = path.join(__dirname, 'data', 'watchlist.json');
const DEFAULT_WATCHLIST_PATH = path.join(__dirname, 'data', 'watchlist.default.json');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));

// Performance: High-speed HTTP Connection Pool & Keep-Alive Agent
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 60,
  maxFreeSockets: 30,
  timeout: 30000
});

const defaultRequestOptions = {
  agent: { https: httpsAgent }
};

// Search response cache (TTL: 10 minutes)
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

// Individual App Details Cache (TTL: 30 minutes) - ensures 0ms repeat fetches for apps
const appDetailCache = new Map();
const APP_CACHE_TTL = 30 * 60 * 1000;

function getFromCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setToCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  // Keep cache size bounded
  if (cache.size > 200) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Format numbers nicely (e.g. 15000000 -> "15M+")
function formatNumber(num) {
  if (!num || isNaN(num)) return '0';
  if (num >= 1e9) return (num / 1e9).toFixed(1).replace(/\.0$/, '') + 'B+';
  if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'M+';
  if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K+';
  return num.toString();
}

// Calculate if released in recent window (last ~12 months)
function checkIsNewRelease(releasedStr) {
  if (!releasedStr) return false;
  try {
    const releaseDate = new Date(releasedStr);
    if (isNaN(releaseDate.getTime())) return false;
    const now = new Date();
    const diffMonths = (now.getFullYear() - releaseDate.getFullYear()) * 12 + (now.getMonth() - releaseDate.getMonth());
    return diffMonths <= 12;
  } catch {
    return false;
  }
}

// Calculate if updated recently (last 60 days)
function checkIsRecentlyUpdated(updatedTimestamp) {
  if (!updatedTimestamp) return false;
  const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
  return (Date.now() - updatedTimestamp) <= sixtyDaysMs;
}

// Calculate granular download estimate based on review velocity and milestone tier
function calculateGranularEstimate(minInstalls, reviews) {
  if (!minInstalls || minInstalls < 1) return '0+';
  if (!reviews || reviews < 1) return formatNumber(minInstalls) + '+';

  // Mobile games average ~1.5% review rate (0.012 - 0.02)
  const estEngaged = Math.round(reviews / 0.015);
  const estimate = Math.max(minInstalls, estEngaged);
  return formatNumber(estimate) + ' (Est.)';
}

// Enrich an app or list of apps with full details in chunked batches
async function enrichAppDetails(rawApps, maxBatch = null) {
  // If maxBatch is set, take up to that number; otherwise, process 100% of all apps with NO slicing!
  const slice = (maxBatch && typeof maxBatch === 'number' && maxBatch > 0) 
    ? rawApps.slice(0, maxBatch) 
    : rawApps;
  const chunkSize = 50; // Increased concurrency for 2x faster enrichment
  const enriched = [];

  for (let i = 0; i < slice.length; i += chunkSize) {
    const chunk = slice.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(
      chunk.map(async (raw) => {
        // 1. Instant Cache Hit (0ms)
        if (appDetailCache.has(raw.appId)) {
          const cached = appDetailCache.get(raw.appId);
          if (Date.now() - cached.timestamp < APP_CACHE_TTL) {
            return cached.data;
          }
        }

        try {
          const full = await gplay.app({ appId: raw.appId, requestOptions: defaultRequestOptions });
          const minInstalls = full.minInstalls || 0;
          const reviews = full.reviews || 0;
          const appObj = {
            appId: full.appId,
            title: full.title || raw.title,
            url: full.url || `https://play.google.com/store/apps/details?id=${full.appId}`,
            icon: full.icon || raw.icon,
            headerImage: full.headerImage,
            developer: full.developer || raw.developer,
            developerId: full.developerId,
            score: typeof full.score === 'number' ? Math.round(full.score * 10) / 10 : 0,
            scoreText: full.scoreText || (full.score ? full.score.toFixed(1) : 'N/A'),
            reviews: reviews,
            installs: full.installs || '0+',
            minInstalls: minInstalls,
            estimatedDownloads: calculateGranularEstimate(minInstalls, reviews),
            genre: full.genre || 'Game',
            genreId: full.genreId,
            price: full.price || 0,
            free: full.free !== false,
            currency: full.currency || 'USD',
            released: full.released || 'Unknown',
            releaseTimestamp: full.released ? new Date(full.released).getTime() : 0,
            updated: full.updated || 0,
            updatedFormatted: full.updated ? new Date(full.updated).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unknown',
            version: full.version || 'Varies with device',
            summary: full.summary || '',
            description: full.description || '',
            screenshots: full.screenshots || [],
            isNewRelease: checkIsNewRelease(full.released),
            isRecentlyUpdated: checkIsRecentlyUpdated(full.updated)
          };

          // Save to App Cache
          appDetailCache.set(full.appId, { data: appObj, timestamp: Date.now() });
          return appObj;
        } catch (err) {
          // Fallback to basic info if app detail fetch fails
          return {
            appId: raw.appId,
            title: raw.title,
            url: raw.url || `https://play.google.com/store/apps/details?id=${raw.appId}`,
            icon: raw.icon,
            developer: raw.developer,
            score: raw.score || 0,
            scoreText: raw.scoreText || 'N/A',
            reviews: raw.reviews || 0,
            installs: raw.installs || 'N/A',
            minInstalls: raw.minInstalls || 0,
            estimatedDownloads: raw.installs || 'N/A',
            genre: raw.genre || 'Game',
            free: raw.free !== false,
            released: raw.released || 'Unknown',
            releaseTimestamp: 0,
            updated: raw.updated || 0,
            updatedFormatted: 'Unknown',
            summary: raw.summary || '',
            screenshots: [],
            isNewRelease: false,
            isRecentlyUpdated: false
          };
        }
      })
    );
    enriched.push(...chunkResults);
  }

  return enriched;
}

// Compute aggregate metrics for a company or search catalog
function computeAnalytics(apps) {
  let totalEstimatedDownloads = 0;
  let totalRatingsSum = 0;
  let ratedAppsCount = 0;
  let totalReviews = 0;
  let newReleasesCount = 0;
  let recentlyUpdatedCount = 0;
  const genreCounts = {};

  let newestApp = null;
  let highestDownloadApp = null;

  for (const app of apps) {
    if (app.minInstalls) {
      totalEstimatedDownloads += app.minInstalls;
    }
    if (app.score && app.score > 0) {
      totalRatingsSum += app.score;
      ratedAppsCount++;
    }
    if (app.reviews) {
      totalReviews += app.reviews;
    }
    if (app.isNewRelease) {
      newReleasesCount++;
    }
    if (app.isRecentlyUpdated) {
      recentlyUpdatedCount++;
    }

    const g = app.genre || 'Other';
    genreCounts[g] = (genreCounts[g] || 0) + 1;

    // Track newest
    if (app.releaseTimestamp && (!newestApp || app.releaseTimestamp > newestApp.releaseTimestamp)) {
      newestApp = app;
    }

    // Track top downloaded
    if (!highestDownloadApp || (app.minInstalls || 0) > (highestDownloadApp.minInstalls || 0)) {
      highestDownloadApp = app;
    }
  }

  const topGenres = Object.entries(genreCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([genre, count]) => ({ genre, count }));

  const avgRating = ratedAppsCount > 0 ? (totalRatingsSum / ratedAppsCount).toFixed(1) : 'N/A';

  return {
    totalApps: apps.length,
    totalEstimatedDownloads,
    formattedDownloads: formatNumber(totalEstimatedDownloads),
    totalReviews,
    formattedReviews: formatNumber(totalReviews),
    averageRating: avgRating,
    newReleasesCount,
    recentlyUpdatedCount,
    topGenres,
    dominantGenre: topGenres.length > 0 ? topGenres[0].genre : 'N/A',
    newestApp: newestApp ? { title: newestApp.title, released: newestApp.released, appId: newestApp.appId } : null,
    highestDownloadApp: highestDownloadApp ? { title: highestDownloadApp.title, installs: highestDownloadApp.installs } : null
  };
}

// Endpoint 1: Search (Company or Keyword)
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  const qLower = query.toLowerCase();
  const mode = req.query.mode === 'keyword' ? 'keyword' : 'company';

  // Crawl depth / limit option - defaults to 400, 'all' removes any cap completely
  const isNoCap = (req.query.limit === 'all');
  let limit = 400;
  if (!isNoCap && req.query.limit) {
    const parsed = parseInt(req.query.limit, 10);
    if (!isNaN(parsed) && parsed > 0) limit = parsed;
  }

  if (!query) {
    return res.status(400).json({ success: false, error: 'Query parameter "q" is required.' });
  }

  const cacheKey = `${mode}:${query.toLowerCase()}:${limit}`;
  const cached = getFromCache(cacheKey);
  if (cached) {
    return res.json({ ...cached, fromCache: true });
  }

  try {
    let rawApps = [];
    let resolvedCompany = query;

    if (mode === 'company') {
      const qLower = query.toLowerCase().trim();

      // 1. Try direct developer lookup (preserving user casing)
      try {
        const directDev = await gplay.developer({ devId: query, num: limit, requestOptions: defaultRequestOptions });
        if (directDev && directDev.length > 0) {
          rawApps = directDev;
          resolvedCompany = directDev[0].developer || query;
        }
      } catch (err) {
        // Direct devId failed (404 due to casing or typo)
      }

      // 2. If direct lookup failed or returned empty, search Play Store and rank candidate developers
      if (rawApps.length === 0) {
        const searchResults = await gplay.search({ term: query, num: 30, requestOptions: defaultRequestOptions });
        if (searchResults && searchResults.length > 0) {
          let bestCandidate = null;

          // Priority A: Exact developer name match (case-insensitive)
          for (const item of searchResults) {
            const devLower = (item.developer || '').toLowerCase().trim();
            if (devLower === qLower) {
              bestCandidate = item;
              break;
            }
          }

          // Priority B: Substring match (e.g. "Virtualize" matches "Virtualize Technologies")
          if (!bestCandidate) {
            for (const item of searchResults) {
              const devLower = (item.developer || '').toLowerCase().trim();
              if (devLower.includes(qLower) || qLower.includes(devLower)) {
                bestCandidate = item;
                break;
              }
            }
          }

          // Priority C: Most frequent developer in top results (for typos like "voodho")
          if (!bestCandidate) {
            const devFrequency = {};
            for (const item of searchResults) {
              const dev = item.developer;
              if (dev) devFrequency[dev] = (devFrequency[dev] || 0) + 1;
            }
            const sortedDevs = Object.entries(devFrequency).sort((a, b) => b[1] - a[1]);
            if (sortedDevs.length > 0) {
              bestCandidate = searchResults.find(a => a.developer === sortedDevs[0][0]);
            }
          }

          if (bestCandidate) {
            resolvedCompany = bestCandidate.developer;

            // 1. First try resolved developer name directly (returns full 88+ catalog for studios like Lion Studios)
            try {
              const devApps = await gplay.developer({ devId: bestCandidate.developer, num: limit, requestOptions: defaultRequestOptions });
              if (devApps && devApps.length > 0) {
                rawApps = devApps;
              }
            } catch (errDevName) {
              // Dev name endpoint returned 404
            }

            // 2. If name endpoint failed, lookup numeric developerId from app details (for numeric dev page accounts)
            if (rawApps.length === 0) {
              try {
                const fullApp = await gplay.app({ appId: bestCandidate.appId, requestOptions: defaultRequestOptions });
                const numericDevId = fullApp.developerId;
                if (numericDevId) {
                  const devApps = await gplay.developer({ devId: numericDevId, num: limit, requestOptions: defaultRequestOptions });
                  if (devApps && devApps.length > 0) {
                    rawApps = devApps;
                  }
                }
              } catch (e) {
                // Numeric dev endpoint failed
              }
            }

            // 3. Fallback: filter search results strictly to matching developer
            if (rawApps.length === 0) {
              rawApps = searchResults.filter(a => (a.developer || '').toLowerCase() === resolvedCompany.toLowerCase());
            }
          }

          // As fallback, strictly filter by developer matching query
          if (rawApps.length === 0) {
            rawApps = searchResults.filter(a => (a.developer || '').toLowerCase().includes(qLower));
            if (rawApps.length > 0) {
              resolvedCompany = rawApps[0].developer;
            }
          }
        }
      }
    } else {
      // Keyword Mode: Full Universe Deep Crawl Engine (A-Z + Digraphs + Year + Theme vectors)
      const currentYear = new Date().getFullYear();
      const prevYear = currentYear - 1;
      const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
      const numbers = '0123456789'.split('');
      
      const standardThemes = [
        '',
        ' game',
        ' games',
        ' puzzle',
        ' 3d',
        ` ${currentYear}`,
        ` ${prevYear}`,
        ' new',
        ' online',
        ' offline',
        ' tap',
        ' sort',
        ' merge',
        ' match'
      ];

      const extendedThemes = [
        ' master', ' rush', ' mania', ' blast', ' pop', ' challenge', ' adventure',
        ' simulator', ' arena', ' legend', ' runner', ' hero', ' quest'
      ];

      // Build query vectors based on requested crawl depth
      const genericVectors = [
        ...standardThemes,
        ...letters.map(l => ` ${l}`),
        ...(isNoCap || limit > 400 ? [...numbers.map(n => ` ${n}`), ...extendedThemes] : [])
      ];

      // Bidirectional Search Vectors (Suffix + Prefix) to catch games with keywords in subtitles (e.g. "Arrow Escape : Sand Sort")
      const prefixActions = [
        'escape ',
        'sort ',
        'drop ',
        'block ',
        'dig ',
        'pour ',
        'color ',
        'fall ',
        'roll '
      ];

      const suffixQueries = genericVectors.map(suffix => `${query}${suffix}`);
      const prefixQueries = prefixActions.map(prefix => `${prefix}${query}`);
      const allQueries = [...prefixQueries, ...suffixQueries];
      const chunkSize = 25; // 2.5x higher vector parallelism
      const rawList = [];

      for (let i = 0; i < allQueries.length; i += chunkSize) {
        const chunk = allQueries.slice(i, i + chunkSize);
        const results = await Promise.all(
          chunk.map(q => gplay.search({ term: q, num: 30, requestOptions: defaultRequestOptions }).catch(() => []))
        );
        results.forEach(r => rawList.push(...r));
      }

      const appMap = new Map();
      for (const item of rawList) {
        if (item && item.appId && !appMap.has(item.appId)) {
          appMap.set(item.appId, item);
        }
      }

      // Precision Relevance Filter: Match Game Title and Package ID ONLY
      // Description is completely omitted to eliminate irrelevant apps (like Sonic Dash) and speed up enrichment by 3x.
      const qWords = qLower.split(/\s+/).filter(w => w.length > 1);
      const titleWordPatterns = qWords.map(w => new RegExp(`\\b${escapeRegex(w)}`, 'i'));

      rawApps = Array.from(appMap.values()).filter(a => {
        const title = a.title || '';
        const appId = (a.appId || '').toLowerCase();
        
        // 1. Matches Title (word starts with keyword, e.g. "sand", "sandy", "arrow", "arrows")
        const titleMatch = titleWordPatterns.some(pat => pat.test(title));
        if (titleMatch) return true;

        // 2. Matches Package Name (e.g. com.vt.arrowsort3d or com.arrow.out)
        const appIdMatch = qWords.some(w => appId.includes(w));
        return appIdMatch;
      });

      resolvedCompany = null;
    }

    if (!rawApps || rawApps.length === 0) {
      const emptyResult = {
        success: true,
        mode,
        query,
        resolvedCompany,
        stats: computeAnalytics([]),
        apps: []
      };
      setToCache(cacheKey, emptyResult);
      return res.json(emptyResult);
    }

    // Enrich all apps with full metadata (installs, release date, version, etc.)
    const enrichedApps = await enrichAppDetails(rawApps, isNoCap ? null : limit);
    const stats = computeAnalytics(enrichedApps);

    const responsePayload = {
      success: true,
      mode,
      query,
      resolvedCompany,
      stats,
      apps: enrichedApps
    };

    setToCache(cacheKey, responsePayload);
    res.json(responsePayload);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to extract data from Play Store: ' + error.message
    });
  }
});

// Endpoint 1.5: Trending Top Charts (by Country, Category, Collection)
app.get('/api/trending', async (req, res) => {
  const country = (req.query.country || 'us').toLowerCase().trim();
  const categoryRaw = (req.query.category || 'GAME').toUpperCase().trim();
  const collectionRaw = (req.query.collection || 'TOP_FREE').toUpperCase().trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 10), 100);

  // Validate collection
  const validCollections = {
    'TOP_FREE': gplay.collection.TOP_FREE,
    'GROSSING': gplay.collection.GROSSING,
    'TOP_PAID': gplay.collection.TOP_PAID
  };
  const collection = validCollections[collectionRaw] || gplay.collection.TOP_FREE;

  // Validate category
  const category = gplay.category[categoryRaw] || gplay.category.GAME;

  const cacheKey = `trending:${country}:${categoryRaw}:${collectionRaw}:${limit}`;
  const cached = getFromCache(cacheKey);
  if (cached) {
    return res.json({ ...cached, fromCache: true });
  }

  try {
    const rawList = await gplay.list({
      category,
      collection,
      country,
      num: limit,
      requestOptions: defaultRequestOptions
    });

    if (!rawList || rawList.length === 0) {
      const emptyResult = {
        success: true,
        mode: 'trending',
        country,
        category: categoryRaw,
        collection: collectionRaw,
        stats: computeAnalytics([]),
        apps: []
      };
      setToCache(cacheKey, emptyResult);
      return res.json(emptyResult);
    }

    const enrichedApps = await enrichAppDetails(rawList, limit);
    const stats = computeAnalytics(enrichedApps);

    const countryNames = {
      'us': 'United States',
      'in': 'India',
      'gb': 'United Kingdom',
      'ca': 'Canada',
      'de': 'Germany',
      'br': 'Brazil',
      'jp': 'Japan',
      'kr': 'South Korea'
    };

    const responsePayload = {
      success: true,
      mode: 'trending',
      country,
      countryName: countryNames[country] || country.toUpperCase(),
      category: categoryRaw,
      collection: collectionRaw,
      stats,
      apps: enrichedApps
    };

    setToCache(cacheKey, responsePayload);
    res.json(responsePayload);
  } catch (error) {
    console.error('Trending fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch Trending Top Charts from Play Store: ' + error.message
    });
  }
});

// Watchlist Multi-List File Helpers
function dedupeCompanies(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const clean = typeof item === 'string' ? item.trim() : '';
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(clean);
    }
  }
  return result;
}

function getFallbackCompanies() {
  return [
    "Virtualize Technologies",
    "VOODOO",
    "SayGames Ltd",
    "Rollic Games",
    "Lion Studios"
  ];
}

function normalizeWatchlistData(raw) {
  // Migrate legacy flat array format into Multi-List format seamlessly
  if (Array.isArray(raw)) {
    return {
      activeListId: 'global',
      lists: [
        {
          id: 'global',
          name: 'Global Watchlist',
          isGlobal: true,
          companies: dedupeCompanies(raw)
        }
      ]
    };
  }

  if (raw && Array.isArray(raw.lists)) {
    let globalList = raw.lists.find(l => l && (l.id === 'global' || l.isGlobal));
    const customLists = raw.lists
      .filter(l => l && l.id && l.id !== 'global' && !l.isGlobal && typeof l.name === 'string')
      .map(l => ({
        id: String(l.id).trim(),
        name: l.name.trim(),
        isGlobal: false,
        companies: dedupeCompanies(l.companies)
      }));

    if (!globalList) {
      globalList = {
        id: 'global',
        name: 'Global Watchlist',
        isGlobal: true,
        companies: getFallbackCompanies()
      };
    } else {
      globalList = {
        id: 'global',
        name: 'Global Watchlist',
        isGlobal: true,
        companies: dedupeCompanies(globalList.companies)
      };
    }

    const lists = [globalList, ...customLists];
    const hasActive = lists.some(l => l.id === raw.activeListId);

    return {
      activeListId: hasActive ? raw.activeListId : 'global',
      lists
    };
  }

  return null;
}

function loadWatchlistData() {
  try {
    if (fs.existsSync(WATCHLIST_PATH)) {
      const content = fs.readFileSync(WATCHLIST_PATH, 'utf8');
      const parsed = JSON.parse(content);
      const normalized = normalizeWatchlistData(parsed);
      if (normalized) {
        // Persist normalized object if migrated from legacy array
        if (Array.isArray(parsed)) {
          saveWatchlistData(normalized);
        }
        return normalized;
      }
    }

    // Seed local user watchlist from default template on first run so Git pulls never overwrite user edits
    if (fs.existsSync(DEFAULT_WATCHLIST_PATH)) {
      const defaultContent = fs.readFileSync(DEFAULT_WATCHLIST_PATH, 'utf8');
      const parsedDefault = JSON.parse(defaultContent);
      const normalized = normalizeWatchlistData(parsedDefault);
      if (normalized) {
        saveWatchlistData(normalized);
        return normalized;
      }
    }
  } catch (err) {
    console.error('Error loading watchlist:', err);
  }

  const fallbackData = normalizeWatchlistData(getFallbackCompanies());
  saveWatchlistData(fallbackData);
  return fallbackData;
}

function loadWatchlist(listId = null) {
  const data = loadWatchlistData();
  const targetId = listId || data.activeListId || 'global';
  const targetList = data.lists.find(l => l.id === targetId) || data.lists[0];
  return targetList ? targetList.companies : [];
}

function saveWatchlistData(data) {
  try {
    const dir = path.dirname(WATCHLIST_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving watchlist:', err);
    return false;
  }
}

function mergeCompaniesIntoList(targetList, incomingCompanies) {
  const existingSet = new Set(targetList.companies.map(c => c.toLowerCase()));
  const addedItems = [];
  for (const raw of incomingCompanies) {
    const clean = typeof raw === 'string' ? raw.trim() : '';
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!existingSet.has(key)) {
      existingSet.add(key);
      targetList.companies.push(clean);
      addedItems.push(clean);
    }
  }
  return addedItems;
}

function syncCompaniesToGlobal(data, companies) {
  const globalList = data.lists.find(l => l.id === 'global' || l.isGlobal);
  if (!globalList) return [];
  return mergeCompaniesIntoList(globalList, companies);
}

function generateUniqueListId(name, existingLists) {
  const baseSlug = (name || 'list')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'custom-list';
  let candidate = baseSlug;
  let counter = 2;
  const usedIds = new Set(existingLists.map(l => l.id));
  usedIds.add('global');
  usedIds.add('__new__');
  while (usedIds.has(candidate)) {
    candidate = `${baseSlug}-${counter++}`;
  }
  return candidate;
}

function buildWatchlistPayload(data, extra = {}) {
  const activeList = data.lists.find(l => l.id === data.activeListId) || data.lists[0];
  return {
    success: true,
    activeListId: activeList.id,
    activeListName: activeList.name,
    lists: data.lists,
    count: activeList.companies.length,
    companies: activeList.companies,
    ...extra
  };
}

// Developer catalog resolution helper
async function resolveAndFetchDeveloperApps(companyName) {
  const qClean = (companyName || '').trim();
  if (!qClean) return { company: companyName, apps: [] };

  // 1. Direct developer lookup
  try {
    const directDev = await gplay.developer({ devId: qClean, num: 60, requestOptions: defaultRequestOptions });
    if (directDev && directDev.length > 0) {
      return { company: directDev[0].developer || qClean, apps: directDev };
    }
  } catch (err) {}

  // 2. Search fallback & resolve candidate developer
  try {
    const qLower = qClean.toLowerCase();
    const searchResults = await gplay.search({ term: qClean, num: 15, requestOptions: defaultRequestOptions });
    if (searchResults && searchResults.length > 0) {
      let bestCandidate = searchResults.find(a => (a.developer || '').toLowerCase().trim() === qLower) ||
                          searchResults.find(a => (a.developer || '').toLowerCase().includes(qLower)) ||
                          searchResults[0];

      if (bestCandidate) {
        // Try developer name directly first
        try {
          const devApps = await gplay.developer({ devId: bestCandidate.developer, num: 60, requestOptions: defaultRequestOptions });
          if (devApps && devApps.length > 0) {
            return { company: bestCandidate.developer || qClean, apps: devApps };
          }
        } catch (e) {}

        // Fallback to numeric devId
        try {
          const fullApp = await gplay.app({ appId: bestCandidate.appId, requestOptions: defaultRequestOptions });
          if (fullApp && fullApp.developerId) {
            const devApps = await gplay.developer({ devId: fullApp.developerId, num: 60, requestOptions: defaultRequestOptions });
            if (devApps && devApps.length > 0) {
              return { company: bestCandidate.developer || qClean, apps: devApps };
            }
          }
        } catch (e) {
          const matching = searchResults.filter(a => (a.developer || '').toLowerCase() === (bestCandidate.developer || '').toLowerCase());
          if (matching.length > 0) return { company: bestCandidate.developer || qClean, apps: matching };
        }
      }
    }
  } catch (err) {}

  return { company: qClean, apps: [] };
}

// Endpoint 1.7: Watchlist & Multi-List Management
app.get('/api/radar/watchlist', (req, res) => {
  const data = loadWatchlistData();
  const requestedId = (req.query.listId || '').trim();
  const listObj = requestedId ? data.lists.find(l => l.id === requestedId) : null;
  if (listObj) {
    return res.json(buildWatchlistPayload(data, {
      count: listObj.companies.length,
      companies: listObj.companies
    }));
  }
  res.json(buildWatchlistPayload(data));
});

// Add studio(s) to a specific list (auto-syncs to Global if added to a sub-list)
app.post('/api/radar/watchlist', (req, res) => {
  const { companies, company, listId } = req.body || {};
  const data = loadWatchlistData();
  const targetId = (listId || data.activeListId || 'global').trim();
  const targetList = data.lists.find(l => l.id === targetId);

  if (!targetList) {
    return res.status(404).json({ success: false, error: 'Target list not found.' });
  }

  let toAdd = [];
  if (Array.isArray(companies)) {
    toAdd = companies;
  } else if (typeof company === 'string') {
    toAdd = [company];
  } else if (typeof companies === 'string') {
    toAdd = companies.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  }

  const addedToTarget = mergeCompaniesIntoList(targetList, toAdd);

  // Business Rule: Any company added to a sub-list is automatically ensured in Global too
  let syncedToGlobal = [];
  if (targetList.id !== 'global' && toAdd.length > 0) {
    syncedToGlobal = syncCompaniesToGlobal(data, toAdd);
  }

  saveWatchlistData(data);
  res.json(buildWatchlistPayload(data, {
    added: addedToTarget.length,
    syncedToGlobal: syncedToGlobal.length,
    targetListId: targetList.id,
    count: targetList.companies.length,
    companies: targetList.companies
  }));
});

// Remove studio(s) ONLY from the specified list (never deletes from Global unless listId === 'global')
app.delete('/api/radar/watchlist', (req, res) => {
  const companyToRemove = (req.query.company || (req.body && req.body.company) || '').trim().toLowerCase();
  const clearAll = req.query.all === 'true' || (req.body && (req.body.all === true || req.body.clearAll === true));
  const targetId = (req.query.listId || (req.body && req.body.listId) || '').trim();

  const data = loadWatchlistData();
  const resolvedId = targetId || data.activeListId || 'global';
  const targetList = data.lists.find(l => l.id === resolvedId);

  if (!targetList) {
    return res.status(404).json({ success: false, error: 'Target list not found.' });
  }

  if (clearAll) {
    const prevCount = targetList.companies.length;
    targetList.companies = [];
    saveWatchlistData(data);
    return res.json(buildWatchlistPayload(data, {
      deleted: prevCount,
      targetListId: targetList.id,
      count: 0,
      companies: []
    }));
  }

  const initialLength = targetList.companies.length;
  targetList.companies = targetList.companies.filter(c => c.toLowerCase() !== companyToRemove);

  saveWatchlistData(data);
  res.json(buildWatchlistPayload(data, {
    deleted: initialLength - targetList.companies.length,
    targetListId: targetList.id,
    count: targetList.companies.length,
    companies: targetList.companies
  }));
});

// Create a new custom sub-list
app.post('/api/radar/lists', (req, res) => {
  const { name, companies } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) {
    return res.status(400).json({ success: false, error: 'List name is required.' });
  }

  const data = loadWatchlistData();
  const duplicate = data.lists.some(l => l.name.toLowerCase() === cleanName.toLowerCase());
  if (duplicate) {
    return res.status(400).json({ success: false, error: `A list named "${cleanName}" already exists.` });
  }

  const id = generateUniqueListId(cleanName, data.lists);
  const initialCompanies = dedupeCompanies(Array.isArray(companies) ? companies : []);
  const newList = {
    id,
    name: cleanName,
    isGlobal: false,
    companies: initialCompanies
  };

  data.lists.push(newList);
  data.activeListId = id;

  if (initialCompanies.length > 0) {
    syncCompaniesToGlobal(data, initialCompanies);
  }

  saveWatchlistData(data);
  res.json(buildWatchlistPayload(data, { createdList: newList }));
});

// Switch active list (persisted across browser refresh)
app.post('/api/radar/lists/active', (req, res) => {
  const { listId } = req.body || {};
  const data = loadWatchlistData();
  const target = data.lists.find(l => l.id === listId);

  if (!target) {
    return res.status(404).json({ success: false, error: 'Selected list not found.' });
  }

  data.activeListId = target.id;
  saveWatchlistData(data);
  res.json(buildWatchlistPayload(data));
});

// Rename a custom sub-list
app.patch('/api/radar/lists/:id', (req, res) => {
  const listId = req.params.id;
  const cleanName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!cleanName) {
    return res.status(400).json({ success: false, error: 'New list name is required.' });
  }

  const data = loadWatchlistData();
  const target = data.lists.find(l => l.id === listId);
  if (!target) {
    return res.status(404).json({ success: false, error: 'List not found.' });
  }
  if (target.isGlobal || target.id === 'global') {
    return res.status(400).json({ success: false, error: 'Global Watchlist cannot be renamed.' });
  }

  const duplicate = data.lists.some(l => l.id !== listId && l.name.toLowerCase() === cleanName.toLowerCase());
  if (duplicate) {
    return res.status(400).json({ success: false, error: `A list named "${cleanName}" already exists.` });
  }

  target.name = cleanName;
  saveWatchlistData(data);
  res.json(buildWatchlistPayload(data));
});

// Delete a custom sub-list (Global companies remain intact!)
app.delete('/api/radar/lists/:id', (req, res) => {
  const listId = req.params.id;
  const data = loadWatchlistData();
  const target = data.lists.find(l => l.id === listId);

  if (!target) {
    return res.status(404).json({ success: false, error: 'List not found.' });
  }
  if (target.isGlobal || target.id === 'global') {
    return res.status(400).json({ success: false, error: 'Global Watchlist cannot be deleted.' });
  }

  data.lists = data.lists.filter(l => l.id !== listId);
  if (data.activeListId === listId) {
    data.activeListId = 'global';
  }

  saveWatchlistData(data);
  res.json(buildWatchlistPayload(data));
});

// Copy companies from one list into another existing list or a brand-new list
app.post('/api/radar/lists/copy', (req, res) => {
  const { sourceListId, targetListId, newListName } = req.body || {};
  const data = loadWatchlistData();

  const sourceList = data.lists.find(l => l.id === sourceListId);
  if (!sourceList) {
    return res.status(404).json({ success: false, error: 'Source list not found.' });
  }

  let copiedCount = 0;
  let targetList = null;

  if (targetListId === '__new__' || (typeof newListName === 'string' && newListName.trim())) {
    const cleanNewName = (newListName || `${sourceList.name} (Copy)`).trim();
    const duplicate = data.lists.some(l => l.name.toLowerCase() === cleanNewName.toLowerCase());
    if (duplicate) {
      return res.status(400).json({ success: false, error: `A list named "${cleanNewName}" already exists.` });
    }

    const newId = generateUniqueListId(cleanNewName, data.lists);
    targetList = {
      id: newId,
      name: cleanNewName,
      isGlobal: false,
      companies: [...sourceList.companies]
    };
    data.lists.push(targetList);
    copiedCount = targetList.companies.length;
    data.activeListId = newId;
  } else {
    targetList = data.lists.find(l => l.id === targetListId);
    if (!targetList) {
      return res.status(404).json({ success: false, error: 'Destination list not found.' });
    }
    if (targetList.id === sourceList.id) {
      return res.status(400).json({ success: false, error: 'Source and destination lists must be different.' });
    }

    const added = mergeCompaniesIntoList(targetList, sourceList.companies);
    copiedCount = added.length;
    if (targetList.id !== 'global') {
      syncCompaniesToGlobal(data, sourceList.companies);
    }
    data.activeListId = targetList.id;
  }

  saveWatchlistData(data);
  res.json(buildWatchlistPayload(data, {
    copiedCount,
    sourceListName: sourceList.name,
    targetListId: targetList.id,
    targetListName: targetList.name
  }));
});

// Endpoint 1.8: Competitor Launch Radar Scanner (Custom Calendar & Presets)
app.post('/api/radar/scan', async (req, res) => {
  try {
    const { timeframe, startDate, endDate, listId, companies: customCompanies } = req.body || {};

    // Determine target company list from requested listId or active list
    const data = loadWatchlistData();
    const activeListObj = data.lists.find(l => l.id === (listId || data.activeListId)) || data.lists[0];
    const companyList = (Array.isArray(customCompanies) && customCompanies.length > 0)
      ? customCompanies
      : (activeListObj ? activeListObj.companies : []);

    if (companyList.length === 0) {
      return res.json({
        success: true,
        mode: 'radar',
        activeListId: activeListObj ? activeListObj.id : 'global',
        activeListName: activeListObj ? activeListObj.name : 'Watchlist',
        timeframe: timeframe || 'all',
        dateRange: 'No companies in selected list',
        companiesScanned: 0,
        totalLaunches: 0,
        apps: [],
        stats: computeAnalytics([])
      });
    }

    // Determine timestamp range
    const now = new Date();
    let startTs = 0;
    let endTs = Date.now();
    let rangeLabel = 'All Releases';

    const tf = (timeframe || 'month').toLowerCase();

    if (tf === 'today') {
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      startTs = todayStart.getTime();
      endTs = Date.now();
      rangeLabel = 'Today';
    } else if (tf === 'week') {
      startTs = Date.now() - (7 * 24 * 60 * 60 * 1000);
      rangeLabel = 'Last 7 Days';
    } else if (tf === 'month') {
      startTs = Date.now() - (30 * 24 * 60 * 60 * 1000);
      rangeLabel = 'Last 30 Days';
    } else if (tf === 'year') {
      startTs = Date.now() - (365 * 24 * 60 * 60 * 1000);
      rangeLabel = 'Past 12 Months';
    } else if (tf === 'custom' && startDate && endDate) {
      startTs = new Date(startDate + 'T00:00:00Z').getTime();
      endTs = new Date(endDate + 'T23:59:59Z').getTime();
      if (isNaN(startTs)) startTs = 0;
      if (isNaN(endTs)) endTs = Date.now();
      rangeLabel = `${startDate} to ${endDate}`;
    }

    // Check radar cache (TTL: 5 minutes)
    const cacheKey = `radar:${tf}:${startTs}:${endTs}:${companyList.slice().sort().join(',')}`;
    const cached = getFromCache(cacheKey);
    if (cached) {
      return res.json({
        ...cached,
        activeListId: activeListObj ? activeListObj.id : 'global',
        activeListName: activeListObj ? activeListObj.name : 'Global Watchlist',
        fromCache: true
      });
    }

    // Process companies in parallel chunks
    const companyChunkSize = 8;
    const allCompanyResults = [];

    for (let i = 0; i < companyList.length; i += companyChunkSize) {
      const chunk = companyList.slice(i, i + companyChunkSize);
      const results = await Promise.all(
        chunk.map(c => resolveAndFetchDeveloperApps(c))
      );
      allCompanyResults.push(...results);
    }

    // Collect all unique apps across companies
    const appMap = new Map();
    for (const resItem of allCompanyResults) {
      for (const raw of resItem.apps) {
        if (raw && raw.appId && !appMap.has(raw.appId)) {
          if (resItem.company) raw.developer = resItem.company;
          appMap.set(raw.appId, raw);
        }
      }
    }

    const uniqueRawApps = Array.from(appMap.values());

    // Enrich all apps to inspect their exact release timestamps
    const enrichedApps = await enrichAppDetails(uniqueRawApps, null);

    // Filter by release timestamp within target range
    const matchingLaunches = [];
    for (const app of enrichedApps) {
      const relTs = app.releaseTimestamp;
      if (relTs && relTs >= startTs && relTs <= endTs) {
        const daysAgo = Math.max(0, Math.floor((Date.now() - relTs) / (24 * 60 * 60 * 1000)));
        let launchBadge = `${daysAgo}d ago`;
        if (daysAgo === 0) launchBadge = 'Launched Today';
        else if (daysAgo === 1) launchBadge = 'Launched Yesterday';
        else if (daysAgo < 7) launchBadge = `${daysAgo} days ago`;
        else if (daysAgo < 30) launchBadge = `${Math.floor(daysAgo / 7)}w ago`;

        matchingLaunches.push({
          ...app,
          daysAgo,
          launchBadge
        });
      }
    }

    // Sort by release date descending (newest launch first!)
    matchingLaunches.sort((a, b) => (b.releaseTimestamp || 0) - (a.releaseTimestamp || 0));

    const responsePayload = {
      success: true,
      mode: 'radar',
      activeListId: activeListObj ? activeListObj.id : 'global',
      activeListName: activeListObj ? activeListObj.name : 'Global Watchlist',
      timeframe: tf,
      dateRange: rangeLabel,
      startDate: startDate || null,
      endDate: endDate || null,
      companiesScanned: companyList.length,
      totalAppsScanned: uniqueRawApps.length,
      totalLaunches: matchingLaunches.length,
      apps: matchingLaunches,
      stats: computeAnalytics(matchingLaunches)
    };

    setToCache(cacheKey, responsePayload);
    res.json(responsePayload);
  } catch (err) {
    console.error('Radar scan error:', err);
    res.status(500).json({ success: false, error: 'Radar scan failed: ' + err.message });
  }
});

// Endpoint 2: Get live reviews for an app
app.get('/api/reviews', async (req, res) => {
  const appId = req.query.appId;
  const num = Math.min(Math.max(parseInt(req.query.num, 10) || 15, 5), 40);

  if (!appId) {
    return res.status(400).json({ success: false, error: 'Parameter "appId" is required.' });
  }

  const cacheKey = `reviews:${appId}:${num}`;
  const cached = getFromCache(cacheKey);
  if (cached) {
    return res.json({ ...cached, fromCache: true });
  }

  try {
    const reviewsResult = await gplay.reviews({
      appId,
      sort: gplay.sort.NEWEST,
      num
    });

    const reviews = (reviewsResult.data || []).map((rev) => ({
      id: rev.id,
      userName: rev.userName || 'Play Store User',
      userImage: rev.userImage || null,
      date: rev.date ? new Date(rev.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Recent',
      score: rev.score || 5,
      scoreText: rev.scoreText || `${rev.score || 5} Stars`,
      text: rev.text || '',
      thumbsUp: rev.thumbsUp || 0,
      replyDate: rev.replyDate ? new Date(rev.replyDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null,
      replyText: rev.replyText || null
    }));

    const payload = {
      success: true,
      appId,
      count: reviews.length,
      reviews
    };

    setToCache(cacheKey, payload);
    res.json(payload);
  } catch (error) {
    console.error('Reviews error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch reviews: ' + error.message
    });
  }
});

// Endpoint 3: App Deep Dive Details
app.get('/api/app/:id', async (req, res) => {
  const appId = req.params.id;
  try {
    const full = await gplay.app({ appId });
    res.json({ success: true, app: full });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  loadWatchlist();
  console.log(`\n=================================================`);
  console.log(`🚀 Play Store Intelligence Dashboard Running!`);
  console.log(`👉 Access URL: http://localhost:${PORT}`);
  console.log(`=================================================\n`);
});
