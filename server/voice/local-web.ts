import { lookup } from 'node:dns/promises';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';

/**
 * Outils Internet du fournisseur vocal local.
 *
 * Avec OpenAI ou Mistral, la recherche web est un outil hébergé par le fournisseur. En local,
 * c'est Cornelius qui interroge lui-même des sources publiques gratuites, sans clé :
 *   - recherche web (Yahoo, puis Brave Search), lecture d'une page ;
 *   - Wikipédia ;
 *   - actualités (Google Actualités, flux RSS) ;
 *   - trains belges (iRail, horaires SNCB en temps réel) ;
 *   - météo d'un lieu quelconque (Open-Meteo).
 *
 * Seuls la requête et le nom des lieux quittent la maison : aucun identifiant n'est envoyé.
 */

export interface WebToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface WebToolResult {
  /** Texte rendu au modèle (déjà tronqué). */
  output: string;
  sources: { url: string; title: string }[];
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const API_AGENT = 'Cornelius-local/1.0 (+https://github.com/lfpoulain/Cornelius)';
const TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 2_000_000;
const MAX_OUTPUT = 4_000;
const TIME_ZONE = 'Europe/Brussels';

export const WEB_TOOL_NAMES = [
  'web_search',
  'web_read',
  'wikipedia',
  'news',
  'train_belgium',
  'weather_place',
] as const;

export function isWebTool(name: string): boolean {
  return (WEB_TOOL_NAMES as readonly string[]).includes(name);
}

export const WEB_TOOLS: WebToolDefinition[] = [
  {
    name: 'web_search',
    description:
      'Recherche sur Internet. Renvoie titres, adresses et extraits des meilleurs résultats. Utilise-la pour toute information publique, récente ou que tu ne connais pas avec certitude. Pour les détails, lis ensuite une page avec web_read.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Requête courte, en français de préférence.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_read',
    description:
      'Lit le texte d’une page web (adresse obtenue avec web_search). Utile quand les extraits ne suffisent pas.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Adresse http(s) complète.' } },
      required: ['url'],
    },
  },
  {
    name: 'wikipedia',
    description:
      'Cherche un sujet dans Wikipédia et renvoie le début de l’article : culture générale, histoire, science, géographie, biographies.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Sujet recherché.' },
        lang: { type: 'string', description: 'Langue de Wikipédia, « fr » par défaut.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'news',
    description:
      'Derniers articles d’actualité sur un sujet (Google Actualités, Belgique, en français) : titre, média et date.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Sujet de l’actualité.' } },
      required: ['query'],
    },
  },
  {
    name: 'train_belgium',
    description:
      'Horaires réels des trains SNCB en Belgique (iRail) entre deux gares : heures de départ et d’arrivée, durée du trajet, correspondances, retards, voie. Utilise-le pour toute question de train ou de trajet en train en Belgique.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Gare de départ, par exemple « Charleroi-Central ».' },
        to: { type: 'string', description: 'Gare d’arrivée, par exemple « Bruxelles-Central ».' },
        date: { type: 'string', description: 'Date AAAA-MM-JJ ; aujourd’hui si absente.' },
        time: { type: 'string', description: 'Heure HH:MM ; maintenant si absente.' },
        arrive_by: {
          type: 'boolean',
          description: 'Vrai si l’heure donnée est l’heure d’arrivée souhaitée.',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'weather_place',
    description:
      'Météo actuelle et prévisions sur quelques jours pour n’importe quelle ville ou lieu du monde (Open-Meteo).',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'Ville ou lieu.' },
        days: {
          type: 'number',
          description: 'Nombre de jours de prévision, 1 à 7 (3 par défaut).',
        },
      },
      required: ['place'],
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Utilitaires

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  agrave: 'à',
  acirc: 'â',
  ccedil: 'ç',
  ocirc: 'ô',
  ucirc: 'û',
  ugrave: 'ù',
  icirc: 'î',
  iuml: 'ï',
  euml: 'ë',
  laquo: '«',
  raquo: '»',
  euro: '€',
  deg: '°',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

const stripTags = (html: string) =>
  decodeEntities(html.replace(/<[^>]+>/gu, ' '))
    .replace(/\s+/gu, ' ')
    .trim();

/** Texte lisible d'une page HTML : le contenu principal, sans scripts ni menus. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? '');
  let body = html
    .replace(/<(script|style|noscript|svg|template|iframe|form)\b[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ');
  const main =
    /<article\b[\s\S]*?<\/article>/iu.exec(body)?.[0] ??
    /<main\b[\s\S]*?<\/main>/iu.exec(body)?.[0];
  if (main && stripTags(main).length > 400) body = main;
  body = body.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/giu, ' ');
  // Le texte suivi d'une page tient dans ses titres, paragraphes et listes : on les garde seuls
  // quand ils suffisent, ce qui élimine menus, listes de langues et boutons.
  const blocks = [...body.matchAll(/<(h[1-4]|p|li|td|dd|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/giu)]
    .map((match) => stripTags(match[2]!))
    .filter((block) => block.length > 25);
  const prose = blocks.join('\n');
  if (prose.length > 600) return { title, text: prose };
  const text = decodeEntities(
    body.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/giu, '\n').replace(/<[^>]+>/gu, ' '),
  )
    .replace(/[ \t\f\v ]+/gu, ' ')
    .replace(/\s*\n\s*/gu, '\n')
    .replace(/\n{2,}/gu, '\n')
    .trim();
  return { title, text };
}

const clip = (text: string, max = MAX_OUTPUT) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  if (isIP(lower) === 6)
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    );
  const parts = lower.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export type HostResolver = (host: string) => Promise<string[]>;

/** Lit une page de moteur de recherche (texte). */
export type SearchPageGetter = (url: string) => Promise<string>;

/**
 * Les moteurs (Yahoo surtout) renvoient une erreur 500 au `fetch` de Node, reconnaissable à son
 * empreinte : le module https, plus proche d'un navigateur simple, passe.
 */
const defaultSearchPageGetter: SearchPageGetter = (url) =>
  new Promise((resolve, reject) => {
    const request = httpsGet(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,*/*',
          'Accept-Language': 'fr-BE,fr;q=0.9,en;q=0.5',
        },
        timeout: TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          const next = new URL(response.headers.location, url);
          if (next.protocol !== 'https:') return reject(new Error('Redirection refusée.'));
          return void defaultSearchPageGetter(next.toString()).then(resolve, reject);
        }
        if (status !== 200) {
          response.resume();
          return reject(new Error(`HTTP ${status}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PAGE_BYTES) request.destroy(new Error('Page trop lourde.'));
          else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error('Délai dépassé.')));
    request.on('error', reject);
  });

const defaultResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

/**
 * Une page demandée par le modèle ne doit jamais viser le réseau de la maison (Home Assistant,
 * routeur, Cornelius lui-même) : seules les adresses publiques sont permises, redirections comprises.
 */
export async function assertPublicUrl(raw: string, resolve: HostResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Adresse invalide.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Seules les adresses http(s) sont permises.');
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (!host || /(^|\.)(localhost|local|lan|home|internal|arpa)$/iu.test(host))
    throw new Error('Adresse locale refusée.');
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (!addresses.length || addresses.some(isPrivateAddress))
    throw new Error('Adresse locale refusée.');
  return url;
}

function formatTime(epochSeconds: number): string {
  return new Intl.DateTimeFormat('fr-BE', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochSeconds * 1000));
}

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h ${String(rest).padStart(2, '0')}` : `${minutes} min`;
}

const WEATHER_CODES: Record<number, string> = {
  0: 'ciel dégagé',
  1: 'plutôt dégagé',
  2: 'partiellement nuageux',
  3: 'couvert',
  45: 'brouillard',
  48: 'brouillard givrant',
  51: 'bruine légère',
  53: 'bruine',
  55: 'bruine forte',
  56: 'bruine verglaçante',
  57: 'bruine verglaçante forte',
  61: 'pluie faible',
  63: 'pluie',
  65: 'forte pluie',
  66: 'pluie verglaçante',
  67: 'forte pluie verglaçante',
  71: 'neige faible',
  73: 'neige',
  75: 'forte neige',
  77: 'grésil',
  80: 'averses faibles',
  81: 'averses',
  82: 'fortes averses',
  85: 'averses de neige',
  86: 'fortes averses de neige',
  95: 'orage',
  96: 'orage avec grêle',
  99: 'orage avec forte grêle',
};

// ---------------------------------------------------------------------------------------------
// Outils

export function createWebTools(
  fetchImpl: typeof fetch = fetch,
  resolve: HostResolver = defaultResolver,
  now: () => Date = () => new Date(),
  getSearchPage: SearchPageGetter = defaultSearchPageGetter,
) {
  const get = async (url: string, init: RequestInit = {}, agent = USER_AGENT) => {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        'User-Agent': agent,
        'Accept-Language': 'fr-BE,fr;q=0.9,en;q=0.5',
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  };

  const getJson = async <T>(url: string) =>
    (await (await get(url, { headers: { Accept: 'application/json' } }, API_AGENT)).json()) as T;

  type SearchResult = { title: string; url: string; snippet: string };

  /** Yahoo (index Bing) : stable pour un usage modéré, adresses réelles dans le paramètre RU. */
  async function yahooResults(query: string): Promise<SearchResult[]> {
    const html = await getSearchPage(
      `https://fr.search.yahoo.com/search?p=${encodeURIComponent(query)}&ei=UTF-8`,
    );
    const results: SearchResult[] = [];
    for (const block of html.split('<div class="compTitle').slice(1)) {
      const link = /href="[^"]*\/RU=([^/"]+)\/RK=[^"]*"[^>]*aria-label="([^"]*)"/iu.exec(block);
      if (!link) continue;
      let url: string;
      try {
        url = decodeURIComponent(link[1]!);
      } catch {
        continue;
      }
      if (!/^https?:\/\//iu.test(url)) continue;
      const snippet = stripTags(
        /<div class="compText[^"]*"[^>]*>([\s\S]*?)<\/div>/iu.exec(block)?.[1] ?? '',
      );
      results.push({ title: decodeEntities(link[2]!), url, snippet: clip(snippet, 450) });
      if (results.length >= 6) break;
    }
    return results;
  }

  /** Brave Search, en relais (limite vite le débit des robots). */
  async function braveResults(query: string): Promise<SearchResult[]> {
    const html = await getSearchPage(
      `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
    );
    const results: SearchResult[] = [];
    for (const block of html.split('data-type="web"').slice(1)) {
      const url = /<a[^>]*href="(https?:\/\/[^"]+)"/iu.exec(block)?.[1];
      const title = /search-snippet-title[^"]*"[^>]*title="([^"]*)"/iu.exec(block)?.[1];
      if (!url || !title) continue;
      const snippet = stripTags(
        /<div class="content [^"]*"[^>]*>([\s\S]*?)<\/div>/iu.exec(block)?.[1] ?? '',
      );
      results.push({
        title: decodeEntities(title),
        url: decodeEntities(url),
        snippet: clip(snippet, 450),
      });
      if (results.length >= 6) break;
    }
    return results;
  }

  /**
   * Recherche web sans clé : Yahoo, puis Brave. Bing sert des résultats sans rapport aux robots
   * et DuckDuckGo les bloque ; sa réponse instantanée reste le dernier recours.
   */
  async function webSearch(query: string): Promise<WebToolResult> {
    let results: SearchResult[] = [];
    for (const engine of [yahooResults, braveResults]) {
      results = await engine(query).catch(() => []);
      if (results.length) break;
    }
    if (!results.length) {
      // Repli : la réponse instantanée de DuckDuckGo (définitions, entités connues).
      const instant = await getJson<{
        Heading?: string;
        AbstractText?: string;
        AbstractURL?: string;
        Answer?: string;
      }>(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&kl=fr-fr`,
      ).catch(() => null);
      const text = instant?.Answer || instant?.AbstractText;
      if (text)
        return {
          output: JSON.stringify({ query, answer: clip(text, 1500), source: instant?.AbstractURL }),
          sources: instant?.AbstractURL
            ? [{ url: instant.AbstractURL, title: instant.Heading || query }]
            : [],
        };
      return {
        output: JSON.stringify({ query, results: [], note: 'Aucun résultat.' }),
        sources: [],
      };
    }
    return {
      output: clip(JSON.stringify({ query, results })),
      sources: results.map(({ url, title }) => ({ url, title })),
    };
  }

  async function webRead(raw: string): Promise<WebToolResult> {
    let url = await assertPublicUrl(raw, resolve);
    let response: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      response = await fetchImpl(url, {
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'fr-BE,fr;q=0.9,en;q=0.5',
          Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = await assertPublicUrl(new URL(location, url).toString(), resolve);
        continue;
      }
      break;
    }
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'sans réponse'}`);
    const type = response.headers.get('content-type') ?? '';
    if (type && !/text\/(html|plain)|application\/(xhtml|xml|json)/iu.test(type))
      throw new Error(`Contenu non lisible (${type.split(';')[0]}).`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_PAGE_BYTES) throw new Error('Page trop lourde.');
    const buffer = Buffer.from(await response.arrayBuffer()).subarray(0, MAX_PAGE_BYTES);
    const body = buffer.toString('utf8');
    const { title, text } =
      /html/iu.test(type) || /<html/iu.test(body.slice(0, 500))
        ? htmlToText(body)
        : { title: '', text: body };
    return {
      output: JSON.stringify({ url: url.toString(), title, text: clip(text, 5_000) }),
      sources: [{ url: url.toString(), title: title || url.hostname }],
    };
  }

  async function wikipedia(query: string, lang = 'fr'): Promise<WebToolResult> {
    const code = /^[a-z]{2,3}$/u.test(lang) ? lang : 'fr';
    const base = `https://${code}.wikipedia.org`;
    const search = await getJson<{ pages?: { key: string; title: string }[] }>(
      `${base}/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=4`,
    );
    const pages = search.pages ?? [];
    const first = pages[0];
    if (!first)
      return { output: JSON.stringify({ query, note: 'Aucun article trouvé.' }), sources: [] };
    const extract = await getJson<{
      query?: { pages?: Record<string, { title?: string; extract?: string }> };
    }>(
      `${base}/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1&format=json&titles=${encodeURIComponent(first.title)}`,
    );
    const page = Object.values(extract.query?.pages ?? {})[0];
    const url = `${base}/wiki/${encodeURIComponent(first.key)}`;
    return {
      output: JSON.stringify({
        title: page?.title ?? first.title,
        url,
        text: clip(page?.extract ?? '', 3_500),
        otherArticles: pages.slice(1).map((other) => other.title),
      }),
      sources: [{ url, title: `Wikipédia : ${page?.title ?? first.title}` }],
    };
  }

  async function news(query: string): Promise<WebToolResult> {
    const xml = await (
      await get(
        `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=fr&gl=BE&ceid=BE:fr`,
      )
    ).text();
    const items = xml
      .split('<item>')
      .slice(1, 8)
      .map((item) => {
        const tag = (name: string) =>
          stripTags(
            (new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'u').exec(item)?.[1] ?? '').replace(
              /<!\[CDATA\[([\s\S]*?)\]\]>/gu,
              '$1',
            ),
          );
        const published = Date.parse(tag('pubDate'));
        return {
          title: tag('title'),
          source: tag('source'),
          date: Number.isFinite(published)
            ? new Intl.DateTimeFormat('fr-BE', {
                timeZone: TIME_ZONE,
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(published))
            : undefined,
          url: tag('link'),
        };
      })
      .filter((item) => item.title);
    return {
      output: clip(
        JSON.stringify({
          query,
          articles: items.map(({ title, source, date }) => ({ title, source, date })),
        }),
      ),
      sources: items.map(({ url, title }) => ({ url, title })),
    };
  }

  async function trainBelgium(args: {
    from: string;
    to: string;
    date?: string;
    time?: string;
    arrive_by?: boolean;
  }): Promise<WebToolResult> {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(args.date ?? '');
    const time = /^(\d{1,2})[:h](\d{2})$/u.exec(args.time ?? '');
    type Stop = {
      station: string;
      time: string;
      delay: string;
      platform?: string;
      canceled?: string;
      vehicleinfo?: { shortname?: string };
    };
    type Connection = {
      duration: string;
      departure: Stop;
      arrival: Stop;
      vias?: { number?: string; via?: { station: string }[] };
    };
    const query = async (hhmm: string | null, selection: 'departure' | 'arrival', results = 4) => {
      const params = new URLSearchParams({
        from: args.from,
        to: args.to,
        format: 'json',
        lang: 'fr',
        results: String(results),
        timesel: selection,
      });
      if (date) params.set('date', `${date[3]}${date[2]}${date[1]!.slice(2)}`);
      if (hhmm) params.set('time', hhmm);
      const data = await getJson<{ connection?: Connection[] }>(
        `https://api.irail.be/v1/connections?${params}`,
      );
      return data.connection ?? [];
    };
    const hhmm = time ? `${time[1]!.padStart(2, '0')}${time[2]}` : null;
    let found: Connection[];
    try {
      if (args.arrive_by && time) {
        // iRail en mode « arrivée » saute des trains : on part de deux heures et demie plus tôt
        // et on garde les derniers qui arrivent à temps.
        const minutes = Math.max(0, Number(time[1]) * 60 + Number(time[2]) - 150);
        const earlier = `${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}`;
        const day =
          date?.[0] ?? new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now());
        const limit = `${day} ${time[1]!.padStart(2, '0')}:${time[2]}`;
        const local = (epoch: string) =>
          new Intl.DateTimeFormat('sv-SE', {
            timeZone: TIME_ZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(Number(epoch) * 1000));
        const merged = new Map<string, Connection>();
        for (const connection of [
          ...(await query(earlier, 'departure', 6)),
          ...(await query(hhmm, 'arrival', 4).catch(() => [])),
        ])
          merged.set(connection.departure.time + connection.arrival.time, connection);
        found = [...merged.values()]
          .filter((connection) => local(connection.arrival.time) <= limit)
          .sort((a, b) => Number(a.arrival.time) - Number(b.arrival.time))
          .slice(-3);
      } else found = await query(hhmm, 'departure');
    } catch (error) {
      throw new Error(
        `Trajet introuvable (${error instanceof Error ? error.message : String(error)}) : vérifie les noms de gares, par exemple « Bruxelles-Central » ou « Charleroi-Central ».`,
      );
    }
    const connections = found.map((connection) => ({
      date: new Intl.DateTimeFormat('fr-BE', {
        timeZone: TIME_ZONE,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(new Date(Number(connection.departure.time) * 1000)),
      departure: formatTime(Number(connection.departure.time)),
      departureStation: connection.departure.station,
      platform: connection.departure.platform || undefined,
      departureDelayMin: Math.round(Number(connection.departure.delay) / 60) || 0,
      arrival: formatTime(Number(connection.arrival.time)),
      arrivalStation: connection.arrival.station,
      arrivalDelayMin: Math.round(Number(connection.arrival.delay) / 60) || 0,
      duration: formatDuration(Number(connection.duration)),
      changes: Number(connection.vias?.number ?? 0),
      via: connection.vias?.via?.map((via) => via.station),
      train: connection.departure.vehicleinfo?.shortname,
      canceled: connection.departure.canceled === '1' || undefined,
    }));
    return {
      output: JSON.stringify({ source: 'iRail (horaires SNCB en temps réel)', connections }),
      sources: [{ url: 'https://www.belgiantrain.be/', title: 'SNCB via iRail' }],
    };
  }

  async function weatherPlace(place: string, days = 3): Promise<WebToolResult> {
    const geo = await getJson<{
      results?: {
        name: string;
        country?: string;
        admin1?: string;
        latitude: number;
        longitude: number;
      }[];
    }>(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=fr`,
    );
    const location = geo.results?.[0];
    if (!location)
      return { output: JSON.stringify({ place, note: 'Lieu introuvable.' }), sources: [] };
    const count = Math.min(7, Math.max(1, Math.round(days) || 3));
    const forecast = await getJson<{
      current?: { temperature_2m: number; weather_code: number; wind_speed_10m: number };
      daily?: {
        time: string[];
        weather_code: number[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_probability_max: number[];
      };
    }>(
      `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${count}`,
    );
    const daily = forecast.daily;
    return {
      output: JSON.stringify({
        place: [location.name, location.admin1, location.country].filter(Boolean).join(', '),
        now: forecast.current && {
          temperature: forecast.current.temperature_2m,
          sky: WEATHER_CODES[forecast.current.weather_code],
          windKmh: forecast.current.wind_speed_10m,
        },
        days: daily?.time.map((day, index) => ({
          day,
          sky: WEATHER_CODES[daily.weather_code[index] ?? -1],
          min: daily.temperature_2m_min[index],
          max: daily.temperature_2m_max[index],
          rainChance: daily.precipitation_probability_max[index],
        })),
      }),
      sources: [{ url: 'https://open-meteo.com/', title: 'Open-Meteo' }],
    };
  }

  /** Exécute un outil Internet ; une erreur devient un résultat lisible par le modèle. */
  async function run(name: string, rawArgs: string): Promise<WebToolResult> {
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return { output: JSON.stringify({ error: 'Arguments illisibles.' }), sources: [] };
    }
    const text = (key: string) =>
      typeof args[key] === 'string' ? (args[key] as string).trim() : '';
    try {
      switch (name) {
        case 'web_search':
          if (!text('query')) throw new Error('Requête vide.');
          return await webSearch(text('query'));
        case 'web_read':
          return await webRead(text('url'));
        case 'wikipedia':
          if (!text('query')) throw new Error('Requête vide.');
          return await wikipedia(text('query'), text('lang') || 'fr');
        case 'news':
          if (!text('query')) throw new Error('Requête vide.');
          return await news(text('query'));
        case 'train_belgium':
          if (!text('from') || !text('to'))
            throw new Error('Gares de départ et d’arrivée requises.');
          return await trainBelgium({
            from: text('from'),
            to: text('to'),
            date: text('date') || undefined,
            time: text('time') || undefined,
            arrive_by: args.arrive_by === true,
          });
        case 'weather_place':
          if (!text('place')) throw new Error('Lieu requis.');
          return await weatherPlace(text('place'), Number(args.days) || 3);
        default:
          throw new Error(`Outil inconnu : ${name}`);
      }
    } catch (error) {
      return {
        output: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        sources: [],
      };
    }
  }

  /** Repères donnés au modèle : date du jour et façon d'utiliser Internet. */
  function instructions(): string {
    const today = new Intl.DateTimeFormat('fr-BE', {
      timeZone: TIME_ZONE,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(now());
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now());
    return `

Date et heure actuelles : ${today} (${iso}), heure de Belgique.
Accès à Internet : tu peux chercher toi-même sur Internet avec les outils web_search, web_read, wikipedia, news, train_belgium et weather_place. Ne réponds jamais de mémoire à une question factuelle dont tu n’es pas certain (chiffre, date, horaire, prix, personne, actualité, résultat sportif) : vérifie d’abord. Choisis l’outil le plus précis : train_belgium pour un train ou un trajet en train en Belgique (gares SNCB, par exemple « Charleroi-Central », « Bruxelles-Central », « Bruxelles-Midi »), weather_place pour la météo d’une autre ville, wikipedia pour la culture générale, news pour l’actualité, web_search pour le reste. Tu peux enchaîner plusieurs recherches : si les extraits ne suffisent pas, lis la page la plus fiable avec web_read, ou reformule la recherche. Croise deux sources quand c’est important. Prends le temps qu’il faut pour avoir une réponse juste et riche.
Avant de lancer une recherche, dis une courte phrase pour faire patienter (par exemple « Je regarde ça sur Internet. »). Ensuite, donne la réponse à l’oral en quelques phrases naturelles, avec les chiffres utiles, sans lire d’adresse web ni de liste à puces ; cite la source en un mot si c’est utile (« d’après la SNCB… »). Si rien de fiable n’est trouvé, dis-le simplement.`;
  }

  return { run, instructions, tools: WEB_TOOLS };
}
