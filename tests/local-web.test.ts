import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalVoiceAdapter } from '../server/voice/local.js';
import {
  assertPublicUrl,
  createWebTools,
  decodeEntities,
  htmlToText,
  isWebTool,
  promisesSearch,
  searchNotice,
  trainSpeech,
  weatherSpeech,
} from '../server/voice/local-web.js';
import type { VoiceEvent } from '../server/voice/provider.js';

const publicResolver = async () => ['93.184.216.34'];
const fixedNow = () => new Date('2026-11-10T19:00:00Z');

test('entities and page text', () => {
  assert.equal(decodeEntities('L&rsquo;&eacute;t&eacute; &#233; &#x41; &amp;'), 'L’été é A &');
  const paragraph = 'Un paragraphe suffisamment long pour être gardé comme texte. '.repeat(15);
  const { title, text } = htmlToText(
    `<html><head><title>Titre &amp; co</title><script>var x=1</script></head><body><nav><a>Menu</a></nav><main><p>${paragraph}</p><ul><li>Élément de liste assez long pour compter</li></ul></main></body></html>`,
  );
  assert.equal(title, 'Titre & co');
  assert.ok(text.startsWith('Un paragraphe'));
  assert.ok(!text.includes('Menu'));
  assert.ok(!text.includes('var x'));
});

test('pages of the home network are refused', async () => {
  for (const url of [
    'http://192.168.0.39/',
    'http://127.0.0.1:3000/',
    'http://localhost/',
    'http://[::1]/',
    'http://10.0.0.1/',
    'http://homeassistant.local/',
    'file:///etc/passwd',
  ])
    await assert.rejects(assertPublicUrl(url, publicResolver), /refusée|permises/u);
  await assert.rejects(
    assertPublicUrl('https://rebind.example/', async () => ['192.168.0.10']),
    /refusée/u,
  );
  assert.equal(
    (await assertPublicUrl('https://example.com/x', publicResolver)).hostname,
    'example.com',
  );
});

test('web_read refuses a redirect to the home network', async () => {
  const fakeFetch = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'http://192.168.0.39/api/states' },
    })) as typeof fetch;
  const tools = createWebTools(fakeFetch, async (host) =>
    host === '192.168.0.39' ? ['192.168.0.39'] : ['93.184.216.34'],
  );
  const result = await tools.run('web_read', JSON.stringify({ url: 'https://example.com/' }));
  assert.match(result.output, /Adresse locale refusée/u);
});

test('web_search reads Yahoo results, then falls back to Brave', async () => {
  const yahoo = `<div class="compTitle"><h3><a href="https://r.search.yahoo.com/_ylt=x/RV=2/RU=https%3a%2f%2ffr.wikipedia.org%2fwiki%2fEverest/RK=2/RS=y" aria-label="Everest &mdash; Wikip&eacute;dia">x</a></h3></div><div class="compText aAbs"><p>Son altitude est de <b>8 849</b> m.</p></div>`;
  const brave = `<div data-type="web"><a href="https://example.com/everest"><div class="title search-snippet-title x" title="Everest">Everest</div></a><div class="content x">Le toit du monde.</div></div>`;
  const pages: string[] = [];
  let yahooDown = false;
  const tools = createWebTools(fetch, publicResolver, fixedNow, async (url) => {
    pages.push(url);
    if (url.includes('yahoo')) {
      if (yahooDown) throw new Error('HTTP 500');
      return yahoo;
    }
    return brave;
  });
  const first = JSON.parse((await tools.run('web_search', '{"query":"Everest"}')).output);
  assert.equal(first.results[0].url, 'https://fr.wikipedia.org/wiki/Everest');
  assert.equal(first.results[0].title, 'Everest — Wikipédia');
  assert.equal(first.results[0].snippet, 'Son altitude est de 8 849 m.');
  yahooDown = true;
  const second = JSON.parse((await tools.run('web_search', '{"query":"Everest"}')).output);
  assert.equal(second.results[0].url, 'https://example.com/everest');
  assert.ok(pages.some((page) => page.includes('search.brave.com')));
});

test('train_belgium formats iRail connections in Belgian time', async () => {
  let requested = '';
  const fakeFetch = (async (url: string | URL) => {
    requested = String(url);
    return Response.json({
      connection: [
        {
          duration: '3060',
          departure: {
            station: 'Charleroi-Central',
            time: '1794338700', // 20:25 à Bruxelles
            delay: '120',
            platform: '4',
            canceled: '0',
            vehicleinfo: { shortname: 'IC 4520' },
          },
          arrival: { station: 'Bruxelles-Midi', time: '1794341760', delay: '0' },
          vias: { number: '0' },
        },
      ],
    });
  }) as typeof fetch;
  const tools = createWebTools(fakeFetch, publicResolver, fixedNow);
  const result = await tools.run(
    'train_belgium',
    JSON.stringify({ from: 'Charleroi', to: 'Bruxelles', date: '2026-11-12', time: '8:05' }),
  );
  assert.match(requested, /api\.irail\.be\/v1\/connections/u);
  assert.match(requested, /date=121126/u);
  assert.match(requested, /time=0805/u);
  const [connection] = JSON.parse(result.output).connections;
  assert.equal(connection.departure, '20:25');
  assert.equal(connection.arrival, '21:16');
  assert.equal(connection.duration, '51 minutes');
  assert.match(
    JSON.parse(result.output).summary,
    /train de 20 h 25 .*voie 4, direct, arrivée à Bruxelles-Midi à 21 h 16, durée 51 minutes, 2 minutes de retard/u,
  );
  assert.equal(connection.departureDelayMin, 2);
  assert.equal(
    result.speech,
    'D’après la SNCB, le train de 20 h 25 part de Charleroi-Central, voie 4, direct, et arrive à Bruxelles-Midi à 21 h 16 : 51 minutes de trajet, annoncé avec 2 minutes de retard.',
  );
  assert.equal(connection.train, 'IC 4520');
});

test('a failing source becomes a readable error', async () => {
  const tools = createWebTools(
    (async () => new Response('', { status: 503 })) as typeof fetch,
    publicResolver,
  );
  const result = await tools.run('wikipedia', '{"query":"Atomium"}');
  assert.match(JSON.parse(result.output).error, /HTTP 503/u);
  assert.match((await tools.run('news', 'pas du json')).output, /illisibles/u);
});

test('the local voice runs web tools itself and reports the search', async () => {
  let llmCalls = 0;
  let firstRequest: { messages: { role: string; content: string }[]; tools: unknown[] } | null =
    null;
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/health') || path.endsWith('/warmup')) return Response.json({ ok: true });
    if (path.endsWith('/stt')) return Response.json({ text: 'Combien de temps en train ?' });
    if (path.endsWith('/tts')) return new Response(new Uint8Array(3200));
    if (path.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body));
      if (body.max_tokens === 1) return Response.json({ choices: [] });
      llmCalls++;
      firstRequest ??= body;
      const chunks =
        llmCalls === 1
          ? [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'w1',
                          function: { name: 'train_belgium', arguments: '{"from":"A","to":"B"}' },
                        },
                      ],
                    },
                  },
                ],
              },
            ]
          : [{ choices: [{ delta: { content: 'Il faut cinquante et une minutes.' } }] }];
      return new Response(
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
      );
    }
    throw new Error(path);
  }) as typeof fetch;
  const ran: string[] = [];
  const web = createWebTools(fakeFetch, publicResolver, fixedNow);
  const events: VoiceEvent[] = [];
  const adapter = createLocalVoiceAdapter(
    { llmBaseUrl: 'http://llm/v1', llmModel: 'm', voiceUrl: 'http://voice' },
    fakeFetch,
    {
      ...web,
      run: async (name, args) => {
        ran.push(`${name} ${args}`);
        return {
          output: '{"duration":"51 min"}',
          sources: [{ url: 'https://irail.be', title: 'iRail' }],
        };
      },
    },
  );
  const connection = await adapter.connect(
    { instructions: 'sys', tools: [], webSearch: true },
    (event) => events.push(event),
  );
  const tone = (ms: number, amplitude: number) => {
    const pcm = Buffer.alloc(32 * ms);
    for (let i = 0; i < pcm.length / 2; i++)
      pcm.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude), i * 2);
    return pcm;
  };
  const pcm = Buffer.concat([tone(300, 20), tone(800, 8000), tone(900, 20)]);
  for (let offset = 0; offset < pcm.length; offset += 640)
    connection.audio(pcm.subarray(offset, offset + 640));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(ran, ['train_belgium {"from":"A","to":"B"}']);
  assert.ok(!events.some((event) => event.type === 'tool_call'));
  const searches = events.filter((event) => event.type === 'web_search');
  assert.deepEqual(
    searches.map((event) => event.type === 'web_search' && event.active),
    [true, false],
  );
  const answer = events.find((event) => event.type === 'assistant_transcript');
  assert.ok(answer?.type === 'assistant_transcript');
  assert.equal(answer.text, 'Il faut cinquante et une minutes.');
  const request = firstRequest as unknown as {
    messages: { role: string; content: string }[];
    tools: { function: { name: string } }[];
  };
  assert.ok(request.tools.some((tool) => tool.function.name === 'web_search'));
  assert.match(request.messages[0]!.content, /Accès à Internet/u);
  assert.match(request.messages[0]!.content, /2026-11-10/u);
  await connection.close();
});

test('web tools are off when web search is disabled', () => {
  assert.ok(isWebTool('train_belgium'));
  assert.ok(!isWebTool('home_assistant__control'));
});

test('a promise to search without a tool call is spotted', () => {
  assert.ok(promisesSearch('Je regarde ça sur Internet.'));
  assert.ok(promisesSearch('Un instant, je vais vérifier.'));
  assert.ok(!promisesSearch('Il faut cinquante et une minutes.'));
  assert.equal(searchNotice('train_belgium'), 'Je regarde les horaires de la SNCB.');
});

test('trainSpeech gives the two useful trains and the cancelled ones', () => {
  const base = {
    date: 'mardi 10 novembre',
    departureStation: 'Charleroi-Central',
    arrivalStation: 'Bruxelles-Midi',
    departureDelayMin: 0,
    changes: 0,
  };
  const trains = [
    { ...base, departure: '20:54', arrival: '21:45', duration: '51 minutes', canceled: true },
    { ...base, departure: '21:54', arrival: '22:45', duration: '51 minutes', platform: '4' },
    { ...base, departure: '22:25', arrival: '23:17', duration: '53 minutes' },
    { ...base, departure: '22:39', arrival: '00:27', duration: '1 heure 48', changes: 1 },
  ];
  assert.equal(
    trainSpeech(trains, { today: 'mardi 10 novembre' }),
    'D’après la SNCB, le train de 21 h 54 part de Charleroi-Central, voie 4, direct, et arrive à Bruxelles-Midi à 22 h 45 : 51 minutes de trajet. Le suivant part à 22 h 25 et arrive à 23 h 17, direct, 53 minutes. Attention, le train de 20 h 54 est supprimé.',
  );
  assert.match(
    trainSpeech(trains.slice(1, 3), { arriveBy: true, today: 'mardi 10 novembre' }),
    /^D’après la SNCB, le train de 22 h 25 .* Le précédent part à 21 h 54/u,
  );
  assert.match(
    trainSpeech(trains.slice(0, 1), { today: 'x' }),
    /Tous les trains trouvés sont supprimés/u,
  );
});

test('a ready-made answer is spoken as is, without asking the model again', async () => {
  let llmCalls = 0;
  const spokenTexts: string[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/health') || path.endsWith('/warmup')) return Response.json({ ok: true });
    if (path.endsWith('/stt')) return Response.json({ text: 'Le train pour Bruxelles ?' });
    if (path.endsWith('/tts')) {
      spokenTexts.push(JSON.parse(String(init?.body)).text);
      return new Response(new Uint8Array(3200));
    }
    if (path.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body));
      if (body.max_tokens === 1) return Response.json({ choices: [] });
      llmCalls++;
      const chunk = {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 't1', function: { name: 'train_belgium', arguments: '{}' } },
              ],
            },
          },
        ],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    }
    throw new Error(path);
  }) as typeof fetch;
  const web = createWebTools(fakeFetch, publicResolver, fixedNow);
  const events: VoiceEvent[] = [];
  const adapter = createLocalVoiceAdapter(
    { llmBaseUrl: 'http://llm/v1', llmModel: 'm', voiceUrl: 'http://voice' },
    fakeFetch,
    {
      ...web,
      run: async () => ({
        output: '{}',
        sources: [],
        speech: 'D’après la SNCB, le train de 21 h 54 arrive à 22 h 45. Le suivant part à 22 h 25.',
      }),
    },
  );
  const connection = await adapter.connect(
    { instructions: 'sys', tools: [], webSearch: true },
    (event) => events.push(event),
  );
  const tone = (ms: number, amplitude: number) => {
    const pcm = Buffer.alloc(32 * ms);
    for (let i = 0; i < pcm.length / 2; i++)
      pcm.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude), i * 2);
    return pcm;
  };
  const pcm = Buffer.concat([tone(300, 20), tone(800, 8000), tone(900, 20)]);
  for (let offset = 0; offset < pcm.length; offset += 640)
    connection.audio(pcm.subarray(offset, offset + 640));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(llmCalls, 1);
  assert.ok(spokenTexts.includes('D’après la SNCB, le train de 21 h 54 arrive à 22 h 45.'));
  const answer = events.find((event) => event.type === 'assistant_transcript');
  assert.ok(answer?.type === 'assistant_transcript');
  assert.match(answer.text, /^D’après la SNCB, le train de 21 h 54/u);
  await connection.close();
});

test('weatherSpeech says only the asked day, or now and today', () => {
  const days = [
    { day: '2026-11-11', sky: 'pluie', min: 5.2, max: 7.4, rainChance: 100 },
    { day: '2026-11-12', sky: 'bruine', min: 5, max: 10, rainChance: 25 },
  ];
  const now = { temperature: 7.2, sky: 'couvert' };
  assert.equal(
    weatherSpeech('Bruxelles', now, days, 1),
    'Demain à Bruxelles : bruine, de 5 à 10 degrés, 25 % de risque de pluie.',
  );
  assert.equal(
    weatherSpeech('Bruxelles', now, days, undefined),
    'En ce moment à Bruxelles : 7 degrés, couvert. Aujourd’hui : pluie, de 5 à 7 degrés, 100 % de risque de pluie.',
  );
});
