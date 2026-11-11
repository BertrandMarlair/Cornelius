import { captureKey } from './preferences';
import {
  audioPreparation,
  microphoneConstraints,
  preparePcmWorklet,
  preparedAudioContext,
  releaseAudioContext,
  takePreparedMicrophone,
  subscribeAudioPreparation,
} from './preparation';

/** Only local resources: no server request, remote SDP or audio transmission. */
export class LocalAudioConnection {
  /**
   * WebRTC n’existe que pour OpenAI, créé au premier besoin. Les fournisseurs portés par le
   * serveur (voix locale, Mistral) n’en ont pas l’usage, et Chrome refuse toute nouvelle
   * connexion après quelques centaines (« Cannot create so many PeerConnections ») : la
   * présence qui va et vient en préparait une à chaque retour.
   */
  private webrtc: {
    peer: RTCPeerConnection;
    events: RTCDataChannel;
    transceiver: RTCRtpTransceiver;
  } | null = null;
  private sendTrack: MediaStreamTrack | null = null;
  readonly context = preparedAudioContext();
  private readonly settings = captureKey();
  private readonly abort = new AbortController();
  private readonly pcmListeners = new Set<(pcm: ArrayBuffer) => void>();
  private overflowHandler: (() => void) | null = null;
  private overflowed = false;
  private stream: MediaStream | null = null;
  private outgoing: MediaStreamAudioDestinationNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private pendingTrigger: boolean | null = null;
  private silent: GainNode | null = null;
  private capture: Promise<MediaStream> | null = null;
  private description: Promise<string> | null = null;

  constructor(private readonly buffered = false) {}

  usable(buffered = this.buffered): boolean {
    return (
      this.buffered === buffered &&
      !this.abort.signal.aborted &&
      this.settings === captureKey() &&
      this.webrtc?.peer.connectionState !== 'closed' &&
      this.webrtc?.peer.connectionState !== 'failed' &&
      !this.stream?.getAudioTracks().some((track) => track.readyState === 'ended')
    );
  }

  microphone(): Promise<MediaStream> {
    if (!this.capture) {
      this.capture = (async () => {
        this.check();
        const stream =
          takePreparedMicrophone() ??
          (await navigator.mediaDevices.getUserMedia(microphoneConstraints()));
        stream.getTracks().forEach((track) => {
          track.enabled = false;
        });
        if (!this.usable()) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error('Préparation audio annulée.');
        }
        this.stream = stream;
        await preparePcmWorklet(this.context);
        this.check();
        this.source = this.context.createMediaStreamSource(stream);
        this.worklet = new AudioWorkletNode(this.context, 'cornelius-pcm');
        if (this.buffered) this.outgoing = this.context.createMediaStreamDestination();
        this.silent = this.context.createGain();
        this.silent.gain.value = 0;
        this.worklet.port.onmessage = ({ data }: MessageEvent<ArrayBuffer | { type: string }>) => {
          if (this.abort.signal.aborted) return;
          if (data instanceof ArrayBuffer) this.pcmListeners.forEach((listener) => listener(data));
          else if (data.type === 'overflow') {
            this.overflowed = true;
            this.overflowHandler?.();
          }
        };
        if (this.pendingTrigger !== null) {
          this.worklet.port.postMessage({ type: 'trigger', advanced: this.pendingTrigger });
          this.pendingTrigger = null;
        }
        this.source.connect(this.worklet);
        if (this.outgoing) this.worklet.connect(this.outgoing);
        this.worklet.connect(this.silent).connect(this.context.destination);
        // Keep wake detection and local VAD active while the session opens.
        stream.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });
        const media = this.buffered ? this.outgoing!.stream : stream;
        this.sendTrack = media.getAudioTracks()[0] ?? null;
        if (this.webrtc) await this.webrtc.transceiver.sender.replaceTrack(this.sendTrack);
        this.check();
        return stream;
      })();
    }
    return this.capture;
  }

  get peer(): RTCPeerConnection {
    return this.openWebRtc().peer;
  }

  get events(): RTCDataChannel {
    return this.openWebRtc().events;
  }

  private openWebRtc() {
    if (!this.webrtc) {
      this.check();
      const peer = new RTCPeerConnection({ iceCandidatePoolSize: 1 });
      const events = peer.createDataChannel('oai-events');
      // L’offre ne dépend pas du micro : sa piste rejoint l’émetteur dès qu’elle est prête.
      const transceiver = peer.addTransceiver('audio', { direction: 'sendrecv' });
      this.webrtc = { peer, events, transceiver };
      if (this.sendTrack) void transceiver.sender.replaceTrack(this.sendTrack).catch(() => {});
    }
    return this.webrtc;
  }

  /** Offre locale immédiate : ni micro ni collecte ICE à attendre, OpenAI fournit ses candidats. */
  offer(): Promise<string> {
    if (!this.description) {
      this.description = (async () => {
        this.check();
        const offer = await this.peer.createOffer();
        this.check();
        await this.peer.setLocalDescription(offer);
        this.check();
        const sdp = this.peer.localDescription?.sdp;
        if (!sdp) throw new Error('Offre WebRTC indisponible.');
        return sdp;
      })();
      // The session can be preparing its audio graph while the offer fails.
      void this.description.catch(() => {});
    }
    return this.description;
  }

  private check() {
    if (!this.usable()) throw new Error('Préparation audio annulée.');
  }

  subscribePcm(listener: (pcm: ArrayBuffer) => void): () => void {
    this.pcmListeners.add(listener);
    return () => this.pcmListeners.delete(listener);
  }

  onOverflow(handler: () => void): void {
    this.overflowHandler = handler;
    if (this.overflowed) handler();
  }

  triggerAudio(advanced = false, lookbackSeconds?: number): void {
    if (this.worklet) this.worklet.port.postMessage({ type: 'trigger', advanced, lookbackSeconds });
    else this.pendingTrigger = advanced;
  }

  resetAudio(): void {
    this.pendingTrigger = null;
    this.overflowed = false;
    this.worklet?.port.postMessage({ type: 'reset' });
  }

  catchUpAudio(): void {
    this.worklet?.port.postMessage({ type: 'catchup' });
  }

  playAudio(): void {
    this.worklet?.port.postMessage({ type: 'play' });
  }

  pauseAudio(): void {
    this.worklet?.port.postMessage({ type: 'pause' });
  }

  dispose() {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.pcmListeners.clear();
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.silent?.disconnect();
    this.outgoing?.stream.getTracks().forEach((track) => track.stop());
    this.stream?.getTracks().forEach((track) => track.stop());
    this.webrtc?.events.close();
    this.webrtc?.peer.close();
    releaseAudioContext(this.context);
  }
}

type WarmConnection = {
  connection: LocalAudioConnection;
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribe: () => void;
};
let warm: WarmConnection | null = null;

export function releaseWarmAudioConnection() {
  const previous = warm;
  warm = null;
  if (!previous) return;
  if (previous.timer) clearTimeout(previous.timer);
  previous.unsubscribe();
  previous.connection.dispose();
}

/** Local preparation only. A persistent caller releases it when its admission guard ends. */
export function warmAudioConnection(
  persistent = false,
  buffered = false,
  webrtc = true,
): LocalAudioConnection | null {
  if (!audioPreparation().ready) return null;
  if (warm?.connection.usable(buffered)) {
    if (persistent && warm.timer) {
      clearTimeout(warm.timer);
      warm.timer = null;
    }
    return warm.connection;
  }
  releaseWarmAudioConnection();
  const connection = new LocalAudioConnection(buffered);
  warm = {
    connection,
    timer: persistent ? null : setTimeout(releaseWarmAudioConnection, 5000),
    unsubscribe: subscribeAudioPreparation(() => {
      if (!audioPreparation().ready) releaseWarmAudioConnection();
    }),
  };
  // The capture feeds wake detection and the advanced buffer before any admission.
  void Promise.all([connection.microphone(), webrtc ? connection.offer() : null]).catch(() => {
    // A speculative failure must not close a session which has since taken ownership.
    if (warm?.connection === connection) releaseWarmAudioConnection();
  });
  return connection;
}

/** Transfer ownership even if microphone acquisition or ICE is still in progress. */
export function takeAudioConnection(buffered = false) {
  const previous = warm;
  warm = null;
  if (previous) {
    if (previous.timer) clearTimeout(previous.timer);
    previous.unsubscribe();
    if (previous.connection.usable(buffered))
      return { connection: previous.connection, prewarmed: true };
    previous.connection.dispose();
  }
  return { connection: new LocalAudioConnection(buffered), prewarmed: false };
}
