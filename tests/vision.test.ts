import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { ConnectClientEvent, ConnectServerEvent } from 'openai/resources/live/sideband';
import { openDatabase, ProfileRepository, SessionPreferences } from '../server/storage.js';
import { SENSOR_STALE_MS, SessionController } from '../server/controller.js';
import { VisionBridge } from '../server/vision.js';
import { LiveTransport } from '../server/live/transport.js';
import type { LiveGateway } from '../server/live/gateway.js';
import { liveConfiguration } from '../server/live/configuration.js';
import type { VisionMode } from '../shared/types.js';

type VisionCommand = {
  type: string;
  requestId?: string;
  trigger?: string;
  model?: string;
  device?: string;
  question?: string;
};
type LiveEvent = ConnectClientEvent & { content?: string; delegation_id?: string | null };

async function until(check: () => boolean, timeout = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Condition non atteinte.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture(
  t: TestContext,
  mode?: VisionMode,
  options: { sessionMode?: 1 | 2 | 3 | 4; engaged?: boolean } = {},
) {
  const db = openDatabase(':memory:');
  let now = Date.now();
  const profiles = new ProfileRepository(db);
  const sent: LiveEvent[] = [];
  const commands: VisionCommand[] = [];
  const configs: Record<string, unknown>[] = [];
  let handlers!: Parameters<LiveGateway['attach']>[1];
  const gateway: LiveGateway = {
    async create(config) {
      configs.push(config as unknown as Record<string, unknown>);
      return { session: { id: 'live_vision' }, transport: { type: 'webrtc', sdp: 'answer' } };
    },
    attach(_id, value) {
      handlers = value;
      return {
        send: (event) => sent.push(event as LiveEvent),
        dispose() {},
      };
    },
  };
  const live = new LiveTransport(gateway, () => false);
  const preferences = new SessionPreferences(db);
  if (options.sessionMode) preferences.setSessionMode(options.sessionMode);
  const controller = new SessionController(profiles, live, () => now, preferences);
  live.attach(controller);
  const measures: { name: string; details: Record<string, unknown> }[] = [];
  const vision = new VisionBridge(
    db,
    controller,
    () => {},
    () => now,
    1_000,
    (name, details) => measures.push({ name, details }),
  );
  vision.attach((event) => commands.push(event as VisionCommand));
  vision.attachAppender(live);
  vision.onWorkerConnected();
  live.attachVision(vision);
  if (mode) vision.setMode(mode);
  t.after(() => {
    live.dispose();
    db.close();
  });
  let sequence = 0;
  function observe(engaged = options.engaged ?? true, presence = true) {
    controller.heartbeat();
    controller.observe({
      schemaVersion: 1,
      producerBootId: 'camera',
      sequence: ++sequence,
      observedAt: now,
      health: 'ok',
      presence,
      engaged,
      people: presence ? [{ trackId: 'person', profileId: null }] : [],
    });
  }
  observe();
  now += 900;
  observe();
  if (options.sessionMode === 4) {
    // Mode voix : « Cornelius » ouvre la conversation, la caméra s’allume avec elle.
    controller.setWakeWordAvailability(true, null);
    assert.equal(controller.wakeDetected(), true);
  }
  const scope = controller.scope();
  async function ready() {
    await live.offer(scope, 'offer');
    handlers.open();
    live.started(scope);
    assert.equal(controller.snapshot().state.session.phase, 'ready');
  }
  return {
    db,
    profiles,
    controller,
    live,
    vision,
    measures,
    sent,
    commands,
    configs,
    scope,
    ready,
    look(
      input: Parameters<VisionBridge['look']>[0],
      args: unknown = { question: 'Que vois-tu devant le miroir ?' },
    ) {
      return vision.look(input, args);
    },
    observe,
    emit: (event: unknown) => handlers.event(event as ConnectServerEvent),
    capture(trigger: string, requestId: string, description: string, capturedAt = now) {
      vision.receive({
        type: 'vision_result',
        requestId,
        trigger,
        status: 'ready',
        description,
        capturedAt,
        processedAt: now,
      });
    },
    captureScene(trigger: string, requestId: string, description: string, capturedAt = now) {
      vision.receive({
        type: 'scene_result',
        requestId,
        trigger,
        status: 'ready',
        description,
        capturedAt,
        processedAt: now,
      });
    },
    lastCommand(trigger?: string, kind = 'vision') {
      return commands
        .filter((event) => event.type === kind && (!trigger || event.trigger === trigger))
        .at(-1);
    },
    appends() {
      return sent.filter((event) => event.type === 'session.thinking.append');
    },
    confirmAppends() {
      for (const event of sent.filter((event) => event.type === 'session.thinking.append')) {
        handlers.event({
          type: 'session.thinking.appended',
          event_id: 'ack-' + event.event_id,
          client_event_id: event.event_id!,
          start_ms: 0,
          end_ms: 0,
        });
      }
    },
    advance(ms: number, observeAgain = true) {
      now += ms;
      if (observeAgain) observe();
    },
    now: () => now,
  };
}

test('LFM démarre à 1 seconde après ready, un seul ajout puis aucune analyse automatique', async (t) => {
  const f = fixture(t);
  await f.ready();
  f.advance(999);
  f.vision.tick();
  assert.equal(f.lastCommand('scene'), undefined);
  f.advance(1);
  f.vision.tick();
  const command = f.lastCommand('scene')!;
  assert.ok(command.requestId);
  assert.equal(command.question, undefined);
  f.capture('scene', command.requestId!, 'Une personne, canapé derrière.');
  assert.equal(f.appends().length, 1);
  assert.match(f.appends()[0]!.content!, /contexte passif.*canapé/);
  f.advance(1_000);
  f.vision.tick();
  assert.equal(f.commands.filter((event) => event.type === 'vision').length, 1);
  assert.equal(
    f.commands.some((event) => event.type === 'scene_detect'),
    false,
  );
});

test('une longue scène reste entière dans l’admin et dans les fragments Live', async (t) => {
  const f = fixture(t);
  await f.ready();
  f.advance(1_000);
  f.vision.tick();
  const command = f.lastCommand('scene')!;
  const description =
    'Une personne lit une étiquette « 東京 ». '.repeat(32) + 'Un livre rouge est sur la table.';
  f.capture('scene', command.requestId!, description);
  assert.equal(f.vision.snapshot().lastDescription, description);
  assert.equal(f.vision.snapshot().history[0]?.description, description);
  const appends = f.appends();
  assert.ok(appends.length > 1);
  assert.ok(appends.every((event) => Buffer.byteLength(event.content!, 'utf8') <= 400));
  const restored =
    appends[0]!.content! +
    appends
      .slice(1)
      .map((event) => event.content!.replace(/^Caméra locale, suite de la même capture : /, ''))
      .join('');
  const observation = JSON.parse(restored.slice(restored.indexOf('{')));
  assert.equal(observation.description, description);
  assert.equal(observation.question, null);
});

test('mode tool : aucune capture ni ajout automatique à l’ouverture', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  f.advance(1_001);
  f.vision.tick();
  assert.equal(f.commands.filter((event) => event.type === 'vision').length, 0);
  assert.equal(f.appends().length, 0);
});

test('une description périmée n’entre pas au contexte', async (t) => {
  const f = fixture(t);
  await f.ready();
  f.advance(1_001, false);
  f.vision.tick();
  const command = f.lastCommand('scene', 'vision')!;
  f.advance(10_001);
  f.capture('scene', command.requestId!, 'Scène trop ancienne.', f.now() - 10_001);
  assert.equal(f.appends().length, 0);
});

test('une capture livrée après la perte confirmée d’engagement est ignorée', async (t) => {
  const f = fixture(t);
  await f.ready();
  f.advance(1_001, false);
  f.vision.tick();
  const command = f.lastCommand('scene', 'vision')!;
  f.observe(false, false);
  f.advance(SENSOR_STALE_MS + 2_000, false);
  f.controller.tick();
  f.capture('scene', command.requestId!, 'Personne partie.');
  assert.equal(f.appends().length, 0);
});

test('le mode est validé, persisté et conditionne l’outil vision__look', (t) => {
  const f = fixture(t);
  assert.equal(f.vision.snapshot().mode, 'scene');
  assert.equal(f.vision.tools()[0]?.name, 'vision__look');
  assert.throws(() => f.vision.setMode('parfois' as never));
  f.vision.setMode('tool');
  assert.equal(f.vision.tools()[0]?.name, 'vision__look');
  assert.equal(f.vision.handles('vision__look'), true);
  assert.equal(
    f.db.prepare('SELECT vision_mode FROM camera_preferences WHERE id = 1').get()?.vision_mode,
    'tool',
  );
  f.vision.setMode('off');
  assert.deepEqual(f.vision.tools(), []);
});

test('le modèle sélectionné est persisté, publié et propagé au worker', (t) => {
  const f = fixture(t);
  assert.equal(f.vision.snapshot().modelId, '450m');
  assert.throws(() => f.vision.setModel('parfois' as never));
  f.vision.setModel('3b');
  assert.equal(f.vision.snapshot().modelId, '3b');
  assert.equal(f.vision.snapshot().model, 'loading');
  assert.equal(
    f.db.prepare('SELECT vision_model FROM camera_preferences WHERE id = 1').get()?.vision_model,
    '3b',
  );
  const model = f.commands.filter((event) => event.type === 'vision_model').at(-1);
  assert.equal(model?.model, '3b');
  assert.equal(model?.device, 'auto');
  f.vision.receive({ type: 'vision_status', status: 'ready', detail: null, provider: 'CPU' });
  assert.equal(f.vision.snapshot().model, 'ready');
});

test('le calcul vision est automatique par défaut, persisté et propagé au worker', (t) => {
  const f = fixture(t);
  assert.equal(f.vision.snapshot().device, 'auto');
  assert.throws(() => f.vision.setDevice('parfois' as never));
  f.vision.setDevice('cpu');
  assert.equal(f.vision.snapshot().device, 'cpu');
  assert.equal(
    f.db.prepare('SELECT vision_device FROM camera_preferences WHERE id = 1').get()?.vision_device,
    'cpu',
  );
  const command = f.commands.filter((event) => event.type === 'vision_model').at(-1);
  assert.equal(command?.model, '450m');
  assert.equal(command?.device, 'cpu');
});

test('le statut publie le fournisseur LFM', (t) => {
  const f = fixture(t);
  assert.equal(f.vision.snapshot().provider, null);
  f.vision.receive({ type: 'vision_status', status: 'ready', detail: null, provider: 'CPU' });
  assert.equal(f.vision.snapshot().provider, 'CPU');
  assert.equal(f.vision.snapshot().model, 'ready');
  f.vision.onWorkerDisconnected();
  assert.equal(f.vision.snapshot().provider, null);
});

test('la reconnexion rappelle le modèle persisté et relance le warm', (t) => {
  const f = fixture(t);
  f.vision.receive({ type: 'vision_status', status: 'ready', detail: null, provider: 'CPU' });
  f.vision.onWorkerDisconnected();
  assert.equal(f.vision.snapshot().model, 'unknown');
  f.vision.onWorkerConnected();
  // Le modèle choisi est re-signalé au worker, et le warm re-publie vision_status.
  const resend = f.commands.filter((event) => event.type === 'vision_model').at(-1);
  assert.equal(resend?.model, '450m');
  assert.equal(resend?.device, 'auto');
  const warm = f.commands.filter((event) => event.type === 'vision_warm').at(-1);
  assert.ok(warm);
  f.vision.receive({ type: 'vision_status', status: 'ready', detail: null, provider: 'CPU' });
  assert.equal(f.vision.snapshot().model, 'ready');
});

test('les anciens messages de détection ne satisfont jamais une demande LFM', async (t) => {
  const f = fixture(t);
  await f.ready();
  f.advance(1_001);
  f.vision.tick();
  const command = f.lastCommand('scene')!;
  f.captureScene('scene', command.requestId!, 'Ancien worker.');
  assert.equal(f.appends().length, 0);
  assert.equal(f.vision.snapshot().pending, 1);
  f.capture('scene', command.requestId!, 'Une personne.');
  assert.equal(f.appends().length, 1);
});

test('vision__look refuse sans session prête et renvoie une description fraîche', async (t) => {
  const f = fixture(t, 'tool');
  const signal = new AbortController().signal;
  const refused = await f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal,
  });
  assert.equal(refused.status, 'failed');
  assert.match(refused.summary, /session/);
  await f.ready();
  const pending = f.look({ profileId: null, interactionId: f.scope.interactionId, signal });
  const command = f.lastCommand('tool');
  assert.ok(command?.requestId);
  f.capture('tool', command!.requestId!, 'Un canapé, une plante et une porte ouverte.');
  const tool = await pending;
  assert.equal(tool.status, 'succeeded');
  assert.match(String(tool.result?.description), /plante/);
});

test('vision__look transmet les détails au résultat seulement, sans couper le résumé', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  const input = {
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  };
  const pending = f.look(input, { question: 'De quelle couleur est la tasse ?' });
  const command = f.lastCommand('tool')!;
  const description = (
    'La tasse est bleue. ' + 'Une plante verte est derrière elle. '.repeat(24)
  ).trim();
  f.capture('tool', command.requestId!, description);
  const result = await pending;
  assert.equal(result.result?.description, description);
  assert.equal(result.summary.length, 500);
  assert.equal(f.vision.snapshot().lastDescription, description);
  assert.equal(f.vision.snapshot().history[0]?.description, description);
  // La délégation livre déjà la description à Live : un contexte en plus la ferait répéter.
  assert.equal(f.appends().length, 0);
});

test('vision__look est borné dans le temps et libéré à la déconnexion', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signal = new AbortController().signal;
  const timed = f.look({ profileId: null, interactionId: f.scope.interactionId, signal });
  t.mock.timers.tick(10_001);
  const expired = await timed;
  assert.equal(expired.status, 'failed');
  assert.match(expired.summary, /temps/);
  assert.equal(f.commands.at(-1)?.type, 'vision_cancel');
  const pending = f.look({ profileId: null, interactionId: f.scope.interactionId, signal });
  f.vision.onWorkerDisconnected();
  const disconnected = await pending;
  assert.equal(disconnected.status, 'failed');
  assert.match(disconnected.summary, /perception|déconnect/i);
});

test('sans session prête, aucune analyse ne part', (t) => {
  const f = fixture(t);
  f.advance(1_001, false);
  f.vision.tick();
  assert.equal(f.commands.filter((event) => event.type === 'vision').length, 0);
  assert.equal(f.commands.filter((event) => event.type === 'scene_detect').length, 0);
});

test('Live expose vision__look et transmet la description au modèle', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  const config = liveConfiguration(f.vision.tools()) as unknown as {
    instructions?: string;
    delegation: { responses: { tools: { name: string }[]; instructions: string } };
  };
  const names = config.delegation.responses.tools.map((tool) => tool.name);
  assert.ok(names.includes('vision__look'));
  assert.match(config.delegation.responses.instructions, /vision__look/);
  assert.match(String(config.instructions), /vision__look/);
  const engagementConfig = liveConfiguration() as unknown as {
    delegation: { responses: { tools: { name: string }[] } };
  };
  assert.equal(
    engagementConfig.delegation.responses.tools.some((tool) => tool.name === 'vision__look'),
    false,
  );
  f.commands.length = 0;
  f.emit({
    type: 'response.event',
    delegation_id: 'delegation',
    event: {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'look-1',
        name: 'vision__look',
        arguments: JSON.stringify({ question: 'De quelle couleur est ma tasse ?' }),
      },
    },
  });
  await until(() =>
    f.commands.some((event) => event.type === 'vision' && event.trigger === 'tool'),
  );
  const command = f.lastCommand('tool')!;
  assert.equal(command.question, 'De quelle couleur est ma tasse ?');
  f.capture('tool', command.requestId!, 'La tasse est bleue.');
  await until(() => f.sent.some((event) => event.type === 'response.item.create'));
  const item = f.sent.find((event) => event.type === 'response.item.create');
  assert.match(JSON.stringify(item), /La tasse est bleue/);
  assert.match(JSON.stringify(item), /De quelle couleur est ma tasse/);
  assert.match(JSON.stringify(item), /capturedAt/);
  assert.equal(f.appends().length, 0); // Aucun doublon : seule la délégation répond.
});

test('vision__look refuse les demandes périmées sans lancer une capture', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  const signal = new AbortController().signal;
  for (const input of [
    { profileId: null, interactionId: 'ancienne' },
    { profileId: 'autre-profil', interactionId: f.scope.interactionId },
  ]) {
    const result = await f.look({ ...input, signal });
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /périmée/);
  }
  assert.equal(f.lastCommand('tool'), undefined);
});

test('annuler vision__look libère immédiatement la capture et ignore son résultat tardif', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  const abort = new AbortController();
  const pending = f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: abort.signal,
  });
  const command = f.lastCommand('tool')!;
  abort.abort();
  assert.equal((await pending).status, 'failed');
  assert.equal(f.vision.snapshot().pending, 0);
  f.capture('tool', command.requestId!, 'Description annulée.');
  assert.equal(f.vision.snapshot().lastDescription, null);
  assert.equal(f.commands.at(-1)?.type, 'vision_cancel');
});

test('une capture de l’ancien contexte est rejetée avant le prochain tick', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  const pending = f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  });
  const command = f.lastCommand('tool')!;
  const scope = f.controller.scope();
  t.mock.method(f.controller, 'scope', () => ({
    ...scope,
    contextVersion: scope.contextVersion + 1,
  }));
  f.capture('tool', command.requestId!, 'Ancien contexte.');
  assert.equal((await pending).status, 'failed');
  assert.equal(f.vision.snapshot().lastDescription, null);
});

test('le mode désactivé ne précharge aucun modèle à la reconnexion', (t) => {
  const f = fixture(t, 'off');
  f.vision.onWorkerDisconnected();
  f.commands.length = 0;
  f.vision.onWorkerConnected();
  f.vision.setModel('3b');
  assert.equal(
    f.commands.some((event) => event.type === 'vision_warm'),
    false,
  );
});

test('recharger un modèle installé annule les demandes de son ancienne instance', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  const pending = f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  });
  const request = f.lastCommand('tool')!;
  f.vision.modelInstalled('450m');
  assert.equal((await pending).status, 'failed');
  assert.equal(f.vision.snapshot().pending, 0);
  f.capture('tool', request.requestId!, 'Ancien modèle.');
  assert.equal(f.vision.snapshot().lastDescription, null);
});

test('les questions ciblées sont validées avant toute capture, sans tronquer une demande trop longue', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  for (const args of [
    null,
    [],
    {},
    { question: null },
    { question: 42 },
    { question: '' },
    { question: '  \n ' },
    { question: 'x'.repeat(501) },
    { question: 'Ma tasse ?', extra: true },
  ]) {
    const result = await f.look(
      {
        profileId: null,
        interactionId: f.scope.interactionId,
        signal: new AbortController().signal,
      },
      args,
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'invalid_params');
  }
  assert.equal(f.lastCommand('tool'), undefined);
  const pending = f.look(
    { profileId: null, interactionId: f.scope.interactionId, signal: new AbortController().signal },
    { question: '  Que dit cette étiquette ?  ' },
  );
  const command = f.lastCommand('tool')!;
  assert.equal(command.question, 'Que dit cette étiquette ?');
  f.capture('tool', command.requestId!, 'Le texte est trop flou pour être lu.');
  const result = await pending;
  assert.equal(result.result?.question, 'Que dit cette étiquette ?');
  assert.equal(result.result?.capturedAt, f.now());
});

test('un appel Live sans question renvoie invalid_params sans capturer une scène générique', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  f.emit({
    type: 'response.event',
    delegation_id: 'delegation',
    event: {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'missing-question',
        name: 'vision__look',
        arguments: '{}',
      },
    },
  });
  await until(() => f.sent.some((event) => event.type === 'response.item.create'));
  assert.match(
    JSON.stringify(f.sent.find((event) => event.type === 'response.item.create')),
    /invalid_params/,
  );
  assert.equal(f.lastCommand('tool'), undefined);
});

test('deux questions ne partagent jamais une capture ni une réponse tardive annulée', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  const abort = new AbortController();
  const input = { profileId: null, interactionId: f.scope.interactionId, signal: abort.signal };
  const first = f.look(input, { question: 'De quelle couleur est ma tasse ?' });
  const old = f.lastCommand('tool')!;
  const busy = await f.look(input, { question: 'Que dit mon étiquette ?' });
  assert.equal(busy.status, 'failed');
  assert.equal(busy.error?.code, 'busy');
  assert.equal(busy.error?.retryable, true);
  assert.equal(f.lastCommand('tool')!.requestId, old.requestId);
  abort.abort();
  assert.equal((await first).status, 'failed');
  const next = f.look(
    { ...input, signal: new AbortController().signal },
    { question: 'Que dit mon étiquette ?' },
  );
  const current = f.lastCommand('tool')!;
  f.capture('tool', old.requestId!, 'La tasse est bleue.');
  assert.equal(f.vision.snapshot().pending, 1);
  f.capture('tool', current.requestId!, 'Le texte est « Thé vert ».');
  const result = await next;
  assert.equal(result.result?.question, 'Que dit mon étiquette ?');
  assert.equal(result.result?.description, 'Le texte est « Thé vert ».');
});

test('la question visuelle interrompt l’ouverture et ignore tout résultat tardif de celle-ci', async (t) => {
  const f = fixture(t);
  await f.ready();
  f.advance(1_000);
  f.vision.tick();
  const opening = f.lastCommand('scene')!;
  const pending = f.look(
    {
      profileId: null,
      interactionId: f.scope.interactionId,
      signal: new AbortController().signal,
    },
    { question: 'De quelle couleur est ma tasse ?' },
  );
  const command = f.lastCommand('tool')!;
  assert.deepEqual(
    f.commands.slice(-2).map((event) => event.type),
    ['vision_cancel', 'vision'],
  );
  assert.equal(f.vision.snapshot().pending, 1);
  f.vision.receive({ type: 'vision_result', requestId: opening.requestId, status: 'unavailable' });
  f.capture('scene', opening.requestId!, 'Description de l’ouverture annulée.');
  assert.equal(f.appends().length, 0);
  f.capture('tool', command.requestId!, 'La tasse est bleue.');
  assert.equal((await pending).status, 'succeeded');
  f.advance(1_000);
  f.vision.tick();
  assert.equal(f.commands.filter((event) => event.trigger === 'scene').length, 1);
  assert.equal(f.vision.snapshot().history[0]?.question, 'De quelle couleur est ma tasse ?');
  assert.equal(f.vision.snapshot().history[1]?.status, 'replaced');
});

test('une question dès ready couvre l’ouverture même avant le premier tick vision', async (t) => {
  const f = fixture(t);
  await f.ready();
  const pending = f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  });
  f.capture('tool', f.lastCommand('tool')!.requestId!, 'Une tasse.');
  assert.equal((await pending).status, 'succeeded');
  f.advance(1_001);
  f.vision.tick();
  assert.equal(f.lastCommand('scene'), undefined);
  assert.equal(f.vision.snapshot().lastDescription, 'Une tasse.');
});

for (const visible of [true, false]) {
  test(
    'le regard détourné permet la vision pendant la conversation, visage visible : ' + visible,
    async (t) => {
      const f = fixture(t, 'tool');
      await f.ready();
      f.observe(false, visible);
      // Le regard affiché est lissé sur le délai de confirmation (350 ms).
      f.advance(400, false);
      f.observe(false, visible);
      if (visible) assert.notEqual(f.controller.snapshot().state.presence.state, 'engaged');
      assert.equal(f.controller.snapshot().state.session.phase, 'ready');
      const pending = f.look({
        profileId: null,
        interactionId: f.scope.interactionId,
        signal: new AbortController().signal,
      });
      f.capture('tool', f.lastCommand('tool')!.requestId!, 'Le livre est bleu.');
      assert.equal((await pending).status, 'succeeded');
    },
  );
}

test('le mode 1 permet une question visuelle sans engagement préalable', async (t) => {
  const f = fixture(t, 'tool', { sessionMode: 1, engaged: false });
  await f.ready();
  assert.equal(f.controller.snapshot().state.presence.engagementId, null);
  const pending = f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  });
  f.capture('tool', f.lastCommand('tool')!.requestId!, 'Une tasse.');
  assert.equal((await pending).status, 'succeeded');
});

test('une caméra sans observation saine ne lance aucune vision même si la session reste prête', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  f.advance(SENSOR_STALE_MS + 1, false);
  const result = await f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 'failed');
  assert.equal(f.lastCommand('tool'), undefined);
});

test('le contexte d’ouverture est daté et attend la confirmation de tous ses fragments', async (t) => {
  const f = fixture(t);
  await f.ready();
  f.advance(1_000);
  f.vision.tick();
  const description = 'Une tasse bleue. '.repeat(40).trim();
  f.capture('scene', f.lastCommand('scene')!.requestId!, description);
  assert.ok(f.appends().length > 1);
  assert.equal(f.vision.snapshot().appends, 0);
  assert.equal(f.vision.snapshot().history[0]?.injection, 'pending');
  f.confirmAppends();
  await until(() => f.vision.snapshot().appends === 1);
  assert.equal(f.vision.snapshot().history[0]?.injection, 'confirmed');
  assert.ok(f.appends().some((event) => event.content?.includes(new Date(f.now()).toISOString())));
});

test('un canal de perception cassé échoue immédiatement et libère la demande', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  f.vision.attach(() => {
    throw new Error('socket fermé');
  });
  const result = await f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /Envoi/);
  assert.equal(f.vision.snapshot().pending, 0);
});

test('un changement de contexte annule aussi le calcul de la capture en cours au tick', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  const pending = f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  });
  const scope = f.controller.scope();
  t.mock.method(f.controller, 'scope', () => ({
    ...scope,
    contextVersion: scope.contextVersion + 1,
  }));
  f.vision.tick();
  assert.equal((await pending).status, 'failed');
  assert.equal(f.commands.at(-1)?.type, 'vision_cancel');
});

test('changer de modèle avant la restitution invalide même une capture déjà reçue', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  const pending = f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  });
  f.capture('tool', f.lastCommand('tool')!.requestId!, 'Ancien modèle.');
  f.vision.setModel('3b');
  assert.equal((await pending).status, 'failed');
  assert.equal(f.appends().length, 0);
});

test('recharger le worker permet une nouvelle ouverture dans une session encore prête', async (t) => {
  const f = fixture(t);
  await f.ready();
  f.advance(1_000);
  f.vision.tick();
  const old = f.lastCommand('scene')!.requestId;
  f.vision.onWorkerDisconnected();
  f.vision.onWorkerConnected();
  f.vision.tick();
  assert.notEqual(f.lastCommand('scene')!.requestId, old);
  assert.equal(f.vision.snapshot().pending, 1);
});

test('en mode détection, un premier regard pendant l’analyse d’ouverture ne la périme pas', async (t) => {
  const f = fixture(t, 'scene', { sessionMode: 1, engaged: false });
  await f.ready();
  assert.equal(f.controller.snapshot().state.presence.engagementId, null);
  f.advance(1_000);
  f.vision.tick();
  const command = f.lastCommand('scene')!;
  assert.ok(command.requestId);
  f.observe(true);
  f.advance(400, false);
  f.observe(true);
  assert.notEqual(f.controller.snapshot().state.presence.engagementId, null);
  f.vision.tick();
  f.capture('scene', command.requestId!, 'Une personne devant le miroir.');
  assert.equal(f.appends().length, 1);
});

test('chaque analyse rejoint le journal des mesures, réussie ou non, sans sa description', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  const input = {
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  };
  const pending = f.look(input);
  f.advance(1_200, false);
  f.capture('tool', f.lastCommand('tool')!.requestId!, 'Une tasse bleue.');
  assert.equal((await pending).status, 'succeeded');
  const success = f.measures.find((measure) => measure.name === 'vision_tool');
  assert.equal(success?.details.durationMs, 1_200);
  assert.equal(success?.details.model, '450m');
  assert.ok(!JSON.stringify(f.measures).includes('tasse'));
  const failed = f.look(input);
  f.vision.receive({
    type: 'vision_result',
    requestId: f.lastCommand('tool')!.requestId,
    status: 'unavailable',
    detail: 'Aucune image récente.',
  });
  assert.equal((await failed).status, 'failed');
  const failure = f.measures.find((measure) => measure.name === 'vision_echec');
  assert.equal(failure?.details.reason, 'tool · unavailable : Aucune image récente.');
});

test('mode voix : vision__look est proposé, attend la caméra rallumée puis regarde', async (t) => {
  const f = fixture(t, 'tool', { sessionMode: 4 });
  await f.ready();
  const delegation = f.configs[0]!.delegation as { responses: { tools: { name?: string }[] } };
  assert.ok(delegation.responses.tools.some((tool) => tool.name === 'vision__look'));
  // Les images d’avant la conversation sont périmées : la caméra vient de se rallumer.
  f.advance(SENSOR_STALE_MS + 500, false);
  assert.equal(f.controller.presenceScope().healthy, false);
  const pending = f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(f.lastCommand('tool'), undefined);
  f.observe();
  await until(() => f.lastCommand('tool') !== undefined);
  f.capture('tool', f.lastCommand('tool')!.requestId!, 'Une tasse bleue sur la console.');
  const result = await pending;
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.result, {
    question: 'Que vois-tu devant le miroir ?',
    description: 'Une tasse bleue sur la console.',
    capturedAt: f.now(),
  });
});

test('mode voix : sans image de la caméra, la question visuelle échoue proprement', async (t) => {
  const f = fixture(t, 'tool', { sessionMode: 4 });
  await f.ready();
  f.advance(2500, false);
  const abort = new AbortController();
  const pending = f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: abort.signal,
  });
  abort.abort();
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(f.lastCommand('tool'), undefined);
});

test('les messages de la vision parlent du service caméra, sans jargon interne', async (t) => {
  const f = fixture(t, 'tool');
  await f.ready();
  const pending = f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  });
  f.vision.onWorkerDisconnected();
  assert.equal((await pending).summary, 'Service caméra déconnecté.');
  assert.equal(f.vision.snapshot().detail, 'Service caméra déconnecté.');
  const stopped = await f.look({
    profileId: null,
    interactionId: f.scope.interactionId,
    signal: new AbortController().signal,
  });
  assert.equal(stopped.summary, 'Le service caméra n’est pas démarré.');
  f.vision.modelInstalled('450m');
  assert.equal(
    f.vision.snapshot().detail,
    'Modèle installé. Il sera chargé au démarrage du service caméra.',
  );
  for (const text of [stopped.summary, f.vision.snapshot().detail ?? ''])
    assert.doesNotMatch(text, /perception|worker|LFM/i);
});
