import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test, { type TestContext } from 'node:test';
import {
  LocalAudioConnection,
  warmAudioConnection,
  releaseWarmAudioConnection,
  takeAudioConnection,
} from '../web/audio/connection.js';
import {
  prepareAudio,
  invalidateAudioPreparation,
  releasePreparedMicrophone,
} from '../web/audio/preparation.js';
import { createAudioSession, type AudioFailure } from '../web/audio/session.js';
import { flushDiagnostics } from '../web/diagnostics.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(t: TestContext) {
  const peers: Peer[] = [];
  const sockets: { onclose: ((event: { code: number }) => void) | null }[] = [];
  const streams: MediaStream[] = [];
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const contexts: Context[] = [];
  let microphoneCalls = 0;
  let workletLoads = 0;
  let delayed = false;
  let release!: (stream: MediaStream) => void;
  let device = '';
  class Node {
    fftSize = 256;
    gain = { value: 0 };
    port = { onmessage: null, postMessage(_data: unknown) {} };
    connect() {
      return this;
    }
    disconnect() {}
    getFloatTimeDomainData() {}
  }
  class Context extends EventTarget {
    state = 'running';
    destination = new Node();
    audioWorklet = {
      async addModule() {
        workletLoads++;
      },
    };
    constructor() {
      super();
      contexts.push(this);
    }
    async resume() {
      this.state = 'running';
    }
    async close() {
      this.state = 'closed';
    }
    createAnalyser() {
      return new Node();
    }
    createMediaStreamSource() {
      return new Node();
    }
    createMediaStreamDestination() {
      const track = {
        enabled: true,
        readyState: 'live',
        stop() {
          this.readyState = 'ended';
        },
      };
      return {
        stream: {
          getTracks: () => [track],
          getAudioTracks: () => [track],
        },
      };
    }
    createGain() {
      return new Node();
    }
  }
  class Peer extends EventTarget {
    connectionState = 'new';
    iceGatheringState = 'complete';
    onconnectionstatechange: (() => void) | null = null;
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;
    offers = 0;
    tracks: MediaStreamTrack[] = [];
    channel = { onmessage: null as null | ((event: { data: string }) => void), close() {} };
    constructor(readonly configuration: RTCConfiguration) {
      super();
      peers.push(this);
    }
    createDataChannel() {
      return this.channel;
    }
    addTransceiver() {
      const sender = {
        replaceTrack: async (track: MediaStreamTrack | null) => {
          if (track) this.tracks.push(track);
        },
      };
      return { sender };
    }
    async createOffer() {
      this.offers++;
      return { type: 'offer', sdp: 'local-sdp' };
    }
    async setLocalDescription(value: RTCSessionDescriptionInit) {
      this.localDescription = value;
    }
    async setRemoteDescription(value: RTCSessionDescriptionInit) {
      this.remoteDescription = value;
    }
    close() {
      this.connectionState = 'closed';
    }
  }
  function stream() {
    const track = {
      enabled: true,
      readyState: 'live',
      stop() {
        this.readyState = 'ended';
      },
    };
    const value = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    streams.push(value);
    return value;
  }
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: new EventTarget(),
    location: { protocol: 'http:', host: 'localhost' },
    localStorage: { getItem: () => JSON.stringify({ microphone: device }) },
    navigator: {
      mediaDevices: {
        getUserMedia: () => {
          microphoneCalls++;
          return delayed
            ? new Promise<MediaStream>((done) => {
                release = done;
              })
            : Promise.resolve(stream());
        },
      },
    },
    AudioContext: Context,
    RTCPeerConnection: Peer,
    AudioWorkletNode: Node,
    Audio: class {
      autoplay = false;
      srcObject = null;
      pause() {}
      async play() {}
    },
    WebSocket: class {
      static OPEN = 1;
      readyState = 1;
      onclose: ((event: { code: number }) => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      close() {}
    },
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify(url === '/api/media/offer' ? { transport: { sdp: 'answer' } } : {}),
      );
    },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    flushDiagnostics();
    releaseWarmAudioConnection();
    releasePreparedMicrophone();
    invalidateAudioPreparation();
    for (const context of contexts) void context.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    peers,
    sockets,
    streams,
    requests,
    statuses: () =>
      requests.filter((request) => request.url === '/api/media/status').map((r) => r.body.type),
    logged: (name: string) => {
      flushDiagnostics();
      return requests
        .filter((request) => request.url === '/api/client-logs')
        .flatMap((request) => request.body.entries as { name?: string }[])
        .filter((entry) => entry.name === name);
    },
    microphoneCalls: () => microphoneCalls,
    workletLoads: () => workletLoads,
    delayCapture: () => {
      delayed = true;
    },
    resolveCapture: () => {
      const value = stream();
      release(value);
      return value;
    },
    setDevice: (value: string) => {
      device = value;
    },
  };
}

const scope = { interactionId: 'warm-test', profileEpoch: 1, contextVersion: 1 };

test('préparation silencieuse sans cloud, puis réutilisation du micro, du SDP et du worklet', async (t) => {
  const f = fixture(t);
  warmAudioConnection();
  assert.equal(f.peers.length, 0);
  await prepareAudio();
  warmAudioConnection();
  warmAudioConnection();
  await flush();
  assert.equal(f.peers.length, 1);
  assert.equal(f.peers[0]!.configuration.iceCandidatePoolSize, 1);
  assert.equal(f.peers[0]!.offers, 1);
  assert.equal(f.streams[0]!.getAudioTracks()[0]!.enabled, true);
  assert.equal(f.peers[0]!.tracks[0], f.streams[0]!.getAudioTracks()[0]);
  assert.equal(f.requests.length, 0);
  const audio = createAudioSession(scope, () => assert.fail('unexpected failure'));
  await flush();
  assert.equal(f.peers.length, 1);
  assert.equal(f.peers[0]!.offers, 1);
  assert.equal(f.microphoneCalls(), 1);
  assert.equal(f.workletLoads(), 1);
  assert.equal(f.requests.filter((request) => request.url === '/api/media/offer').length, 1);
  assert.equal(f.streams[0]!.getAudioTracks()[0]!.enabled, true);
  for (let i = 0; i < 2; i++)
    f.peers[0]!.channel.onmessage?.({ data: '{"type":"session.started"}' });
  await flush();
  assert.equal(f.logged('audio_demarrage').length, 1);
  assert.equal(f.requests.filter((request) => request.url === '/api/media/status').length, 1);
  audio.dispose();
  assert.equal(f.streams[0]!.getAudioTracks()[0]!.readyState, 'ended');
});

test('l’admission reprend une acquisition microphone encore en cours sans deuxième demande', async (t) => {
  const f = fixture(t);
  await prepareAudio();
  releasePreparedMicrophone();
  f.delayCapture();
  warmAudioConnection();
  const audio = createAudioSession(scope, () => assert.fail('unexpected failure'));
  await flush();
  assert.equal(f.microphoneCalls(), 2); // Initial authorization, then one speculative acquisition.
  const stream = f.resolveCapture();
  await flush();
  assert.equal(f.peers.length, 1);
  assert.equal(f.requests.filter((request) => request.url === '/api/media/offer').length, 1);
  audio.dispose();
  assert.equal(stream.getAudioTracks()[0]!.readyState, 'ended');
});

for (const cancel of ['departure', 'permission'] as const) {
  test(`une acquisition tardive après ${cancel} est libérée sans aucun appel cloud`, async (t) => {
    const f = fixture(t);
    await prepareAudio();
    releasePreparedMicrophone();
    f.delayCapture();
    warmAudioConnection();
    if (cancel === 'permission') invalidateAudioPreparation();
    else releaseWarmAudioConnection();
    const stream = f.resolveCapture();
    await flush();
    assert.equal(stream.getAudioTracks()[0]!.readyState, 'ended');
    assert.equal(f.peers[0]!.connectionState, 'closed');
    assert.equal(f.requests.length, 0);
  });
}

test('la préparation expire après cinq secondes sans fermer une connexion déjà transférée', async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await prepareAudio();
  warmAudioConnection();
  await flush();
  t.mock.timers.tick(5000);
  assert.equal(f.peers[0]!.connectionState, 'closed');
  assert.equal(f.streams[0]!.getAudioTracks()[0]!.readyState, 'ended');
  warmAudioConnection();
  const { connection, prewarmed } = takeAudioConnection();
  assert.equal(prewarmed, true);
  await connection.offer();
  t.mock.timers.tick(5000);
  assert.equal(f.peers[1]!.connectionState, 'new');
  connection.dispose();
});

test('la préparation gardée par la présence reste disponible après cinq secondes', async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await prepareAudio();
  warmAudioConnection(true);
  await flush();
  t.mock.timers.tick(5000);
  assert.equal(f.peers[0]!.connectionState, 'new');
  assert.equal(f.streams[0]!.getAudioTracks()[0]!.readyState, 'live');
  const { connection, prewarmed } = takeAudioConnection();
  assert.equal(prewarmed, true);
  connection.dispose();
});

test('le tampon avancé garde une piste distincte pour rejouer la commande initiale', async (t) => {
  const f = fixture(t);
  await prepareAudio();
  warmAudioConnection(true, true);
  await flush();
  assert.notEqual(f.peers[0]!.tracks[0], f.streams[0]!.getAudioTracks()[0]);
  const { connection, prewarmed } = takeAudioConnection(true);
  assert.equal(prewarmed, true);
  connection.dispose();
});

test('désactiver le tampon remplace la préparation par une piste micro directe', async (t) => {
  const f = fixture(t);
  await prepareAudio();
  warmAudioConnection(true, true);
  await flush();
  const previous = f.peers[0]!;
  const normal = warmAudioConnection(true, false)!;
  await flush();
  assert.equal(previous.connectionState, 'closed');
  const { connection, prewarmed } = takeAudioConnection(false);
  assert.equal(connection, normal);
  assert.equal(prewarmed, true);
  assert.equal(f.peers[1]!.tracks[0], f.streams[1]!.getAudioTracks()[0]);
  connection.dispose();
});

test('un changement de microphone invalide la préparation avant admission', async (t) => {
  const f = fixture(t);
  await prepareAudio();
  warmAudioConnection();
  await flush();
  f.setDevice('new-device');
  const { connection, prewarmed } = takeAudioConnection();
  assert.equal(prewarmed, false);
  assert.equal(f.peers[0]!.connectionState, 'closed');
  connection.dispose();
});

test('l’offre locale n’attend ni la collecte ICE ni le microphone, qui la rejoint ensuite', async (t) => {
  const f = fixture(t);
  f.delayCapture();
  const connection = new LocalAudioConnection();
  assert.equal(f.peers.length, 0); // WebRTC n’est ouvert qu’à la première offre.
  void connection.peer;
  const peer = f.peers[0]!;
  peer.iceGatheringState = 'gathering';
  assert.equal(await connection.offer(), 'local-sdp');
  assert.equal(getEventListeners(peer, 'icegatheringstatechange').length, 0);
  assert.equal(f.microphoneCalls(), 0);
  const capture = connection.microphone();
  const stream = f.resolveCapture();
  await capture;
  assert.equal(peer.tracks[0], stream.getAudioTracks()[0]);
  connection.dispose();
  assert.equal(stream.getAudioTracks()[0]!.readyState, 'ended');
});

test('le serveur est prévenu dès la connexion WebRTC ; une coupure brève est tolérée', async (t) => {
  const f = fixture(t);
  await prepareAudio();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failures: AudioFailure[] = [];
  const audio = createAudioSession(scope, (kind) => failures.push(kind));
  await flush();
  const peer = f.peers.at(-1)!;
  peer.connectionState = 'connected';
  peer.onconnectionstatechange?.();
  await flush();
  assert.deepEqual(f.statuses(), ['connected']);
  peer.connectionState = 'disconnected';
  peer.onconnectionstatechange?.();
  t.mock.timers.tick(4000);
  peer.connectionState = 'connected';
  peer.onconnectionstatechange?.();
  t.mock.timers.tick(2000);
  assert.equal(failures.length, 0);
  peer.connectionState = 'disconnected';
  peer.onconnectionstatechange?.();
  t.mock.timers.tick(5000);
  await flush();
  assert.deepEqual(failures, ['transport']);
  assert.deepEqual(f.statuses(), ['connected', 'failed']);
  audio.dispose();
});

test('une clôture serveur du flux VAD ne retire pas l’autorisation, un micro perdu oui', async (t) => {
  const f = fixture(t);
  await prepareAudio();
  const failures: AudioFailure[] = [];
  const closed = createAudioSession(scope, (kind) => failures.push(kind));
  await flush();
  f.sockets.at(-1)!.onclose?.({ code: 1008 });
  await flush();
  assert.equal(failures.length, 0);
  assert.equal(f.statuses().length, 0);
  closed.dispose();
  const lost = createAudioSession({ ...scope, interactionId: 'lost-microphone' }, (kind) =>
    failures.push(kind),
  );
  await flush();
  const track = f.streams.at(-1)!.getAudioTracks()[0] as MediaStreamTrack & {
    onended: (() => void) | null;
  };
  track.onended?.();
  assert.deepEqual(failures, ['device']);
  lost.dispose();
});

test('un dépassement du tampon avant admission reste signalé au transfert', async (t) => {
  fixture(t);
  await prepareAudio();
  const connection = warmAudioConnection(true, true)!;
  await connection.microphone();
  const worklet = connection as unknown as {
    worklet: { port: { onmessage: ((event: MessageEvent) => void) | null } };
  };
  worklet.worklet.port.onmessage?.({ data: { type: 'overflow' } } as MessageEvent);
  let warnings = 0;
  connection.onOverflow(() => warnings++);
  assert.equal(warnings, 1);
  connection.resetAudio();
  connection.onOverflow(() => warnings++);
  assert.equal(warnings, 1);
});

test('voix portée par le serveur : la préparation n’ouvre aucune connexion WebRTC', async (t) => {
  const f = fixture(t);
  await prepareAudio();
  for (let round = 0; round < 3; round++) {
    // La présence va et vient : chaque retour prépare le micro, jamais WebRTC.
    const connection = warmAudioConnection(true, false, false)!;
    await connection.microphone();
    releaseWarmAudioConnection();
  }
  assert.equal(f.peers.length, 0);
});
