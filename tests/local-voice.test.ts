import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EnergyVad,
  createLocalVoiceAdapter,
  localVoiceSettingsFromEnv,
  speakable,
  takeSentences,
} from '../server/voice/local.js';
import type { VoiceEvent } from '../server/voice/provider.js';

const tone = (ms: number, amplitude: number) => {
  const samples = (16_000 * ms) / 1000;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    pcm.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude), i * 2);
  return pcm;
};
const feed = (vad: EnergyVad, pcm: Buffer) => {
  for (let offset = 0; offset < pcm.length; offset += 640)
    vad.push(pcm.subarray(offset, offset + 640));
};

test('settings only when CORNELIUS_LOCAL_VOICE is set', () => {
  assert.equal(localVoiceSettingsFromEnv({}), null);
  const settings = localVoiceSettingsFromEnv({ CORNELIUS_LOCAL_VOICE: '1' });
  assert.equal(settings?.llmModel, 'qwen3:4b-instruct');
  assert.equal(settings?.voiceUrl, 'http://127.0.0.1:8765');
});

test('vad emits one utterance after speech then silence', () => {
  const utterances: Buffer[] = [];
  const vad = new EnergyVad((pcm) => utterances.push(pcm));
  feed(vad, tone(500, 20));
  feed(vad, tone(800, 8000));
  feed(vad, tone(900, 20));
  assert.equal(utterances.length, 1);
  assert.ok(utterances[0]!.length / 32 >= 800);
});

test('vad ignores a click', () => {
  const utterances: Buffer[] = [];
  const vad = new EnergyVad((pcm) => utterances.push(pcm));
  feed(vad, tone(500, 20));
  feed(vad, tone(100, 8000));
  feed(vad, tone(900, 20));
  assert.equal(utterances.length, 0);
});

test('sentences are cut for streaming speech', () => {
  assert.deepEqual(takeSentences('Bonjour. Il fait beau', false), {
    sentences: ['Bonjour.'],
    rest: 'Il fait beau',
  });
  assert.deepEqual(takeSentences('Il fait 12,5 degrés', true).sentences, ['Il fait 12,5 degrés']);
  assert.equal(speakable('**Bonjour** 👋 <think>x</think>Bertrand'), 'Bonjour Bertrand');
});

test('a spoken turn runs a tool then answers', async () => {
  let llmCalls = 0;
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/health')) return new Response('{"ok":true}');
    if (path.endsWith('/stt')) return Response.json({ text: 'Allume la cuisine' });
    if (path.endsWith('/tts')) return new Response(new Uint8Array(3200));
    if (path.endsWith('/chat/completions')) {
      llmCalls++;
      const body = JSON.parse(String(init?.body));
      const chunks =
        llmCalls === 1
          ? [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: 't1', function: { name: 'ha', arguments: '{"x":' } },
                      ],
                    },
                  },
                ],
              },
              {
                choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }],
              },
            ]
          : [
              { choices: [{ delta: { content: 'C’est fait. ' } }] },
              { choices: [{ delta: { content: 'Autre chose ?' } }] },
            ];
      assert.equal(body.tools[0].function.name, 'ha');
      const text =
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(text);
    }
    throw new Error(path);
  }) as typeof fetch;
  const events: VoiceEvent[] = [];
  const adapter = createLocalVoiceAdapter(
    { llmBaseUrl: 'http://llm/v1', llmModel: 'm', voiceUrl: 'http://voice' },
    fakeFetch,
  );
  const connection = await adapter.connect(
    {
      instructions: 'sys',
      tools: [{ name: 'ha', description: 'd', parameters: {} }],
      webSearch: false,
    },
    (event) => {
      events.push(event);
      if (event.type === 'tool_call') connection.result(event.id, '{"ok":true}');
    },
  );
  const pcm = Buffer.concat([tone(300, 20), tone(800, 8000), tone(900, 20)]);
  for (let offset = 0; offset < pcm.length; offset += 640)
    connection.audio(pcm.subarray(offset, offset + 640));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call' && call.arguments === '{"x":1}');
  const answer = events.find((e) => e.type === 'assistant_transcript');
  assert.ok(answer && answer.type === 'assistant_transcript');
  assert.equal(answer.text, 'C’est fait. Autre chose ?');
  assert.equal(events.filter((e) => e.type === 'assistant_speech').length, 2);
  assert.equal(llmCalls, 2);
  await connection.close();
  assert.equal(events.at(-1)?.type, 'closed');
});
