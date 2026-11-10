import type { VoiceConnection, VoiceEvent, VoiceProviderAdapter } from './provider.js';

/**
 * Fournisseur vocal entièrement local : rien ne quitte le réseau de la maison.
 *
 *   micro (PCM16 16 kHz) → détection de la parole → Whisper (sidecar /stt)
 *     → modèle compatible OpenAI (Ollama, outils compris) → Piper (sidecar /tts) → haut-parleur
 *
 * Le sidecar vocal est `local_voice/voice_server.py`. Ollama sert le modèle.
 */
export interface LocalVoiceSettings {
  /** Base compatible OpenAI, par exemple http://127.0.0.1:11434/v1 (Ollama). */
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string;
  /** Sidecar vocal : POST /stt et POST /tts. */
  voiceUrl: string;
}

export const LOCAL_MAX_SESSION_MS = 15 * 60_000;
const SAMPLE_RATE = 16_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const PRE_ROLL_MS = 300;
const END_SILENCE_MS = 700;
const MIN_SPEECH_MS = 250;
const MAX_UTTERANCE_MS = 15_000;
const ECHO_GUARD_MS = 350;
const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY = 24;

export function localVoiceSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LocalVoiceSettings | null {
  if (!['1', 'true', 'oui'].includes(String(env.CORNELIUS_LOCAL_VOICE ?? '').toLowerCase()))
    return null;
  return {
    llmBaseUrl: (env.CORNELIUS_LOCAL_LLM_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/u, ''),
    llmModel: env.CORNELIUS_LOCAL_LLM_MODEL || 'qwen3:4b-instruct',
    llmApiKey: env.CORNELIUS_LOCAL_LLM_KEY || undefined,
    voiceUrl: (env.CORNELIUS_LOCAL_VOICE_URL || 'http://127.0.0.1:8765').replace(/\/+$/u, ''),
  };
}

function rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Détection de la parole par énergie, avec un plancher de bruit qui s'adapte à la pièce.
 * Le navigateur applique déjà la suppression de bruit et l'annulation d'écho au micro.
 */
export class EnergyVad {
  private noise = 300;
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private preRoll: Buffer[] = [];
  private preRollBytes = 0;
  private utterance: Buffer[] = [];
  private utteranceBytes = 0;

  constructor(private readonly onUtterance: (pcm: Buffer) => void) {}

  get active(): boolean {
    return this.speaking;
  }

  reset(): void {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utterance = [];
    this.utteranceBytes = 0;
  }

  push(pcm: Buffer): void {
    const ms = pcm.length / BYTES_PER_MS;
    const level = rms(pcm);
    const threshold = Math.max(this.noise * 3, 450);
    const voiced = level > threshold;
    if (!this.speaking) {
      // Le plancher ne suit que le silence, lentement.
      if (!voiced) this.noise = this.noise * 0.95 + level * 0.05;
      this.preRoll.push(pcm);
      this.preRollBytes += pcm.length;
      while (this.preRollBytes > PRE_ROLL_MS * BYTES_PER_MS && this.preRoll.length > 1)
        this.preRollBytes -= this.preRoll.shift()!.length;
      if (voiced) {
        this.speechMs += ms;
        if (this.speechMs >= 60) {
          this.speaking = true;
          this.silenceMs = 0;
          this.utterance = [...this.preRoll];
          this.utteranceBytes = this.preRollBytes;
          this.preRoll = [];
          this.preRollBytes = 0;
        }
      } else this.speechMs = 0;
      return;
    }
    this.utterance.push(pcm);
    this.utteranceBytes += pcm.length;
    if (voiced) {
      this.speechMs += ms;
      this.silenceMs = 0;
    } else this.silenceMs += ms;
    const total = this.utteranceBytes / BYTES_PER_MS;
    if (this.silenceMs >= END_SILENCE_MS || total >= MAX_UTTERANCE_MS) {
      const audio = Buffer.concat(this.utterance);
      const enough = this.speechMs >= MIN_SPEECH_MS;
      this.reset();
      if (enough) this.onUtterance(audio);
    }
  }
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Coupe le texte en phrases pour commencer à parler avant la fin de la réponse. */
export function takeSentences(
  buffer: string,
  final = false,
): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  const boundary = /([.!?…;:])(\s+|$)/u;
  for (;;) {
    const match = boundary.exec(rest);
    if (!match || (match.index + match[0].length === rest.length && !final && !match[2])) break;
    const end = match.index + match[1]!.length;
    const sentence = rest.slice(0, end).trim();
    rest = rest.slice(end).trimStart();
    if (sentence) sentences.push(sentence);
  }
  if (final && rest.trim()) {
    sentences.push(rest.trim());
    rest = '';
  }
  return { sentences, rest };
}

/** Retire ce qu'une voix ne sait pas lire : balises de réflexion, Markdown, émojis. */
export function speakable(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gu, '')
    .replace(/[*_`#>|~]/gu, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function createLocalVoiceAdapter(
  settings: LocalVoiceSettings,
  fetchImpl: typeof fetch = fetch,
): VoiceProviderAdapter {
  return {
    async connect(configuration, emit): Promise<VoiceConnection> {
      let config = configuration;
      let closed = false;
      const started = Date.now();
      const history: ChatMessage[] = [];
      const pending = new Map<
        string,
        { resolve(value: string): void; timer: ReturnType<typeof setTimeout> }
      >();
      let turn: AbortController | null = null;
      let busy = false;
      let playbackUntil = 0;
      let counter = 0;
      const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${++counter}`;
      const elapsed = () => Date.now() - started;
      const notify = (event: VoiceEvent) => {
        if (!closed) emit(event);
      };

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.llmApiKey) headers.Authorization = `Bearer ${settings.llmApiKey}`;

      const speak = async (text: string, signal: AbortSignal) => {
        const clean = speakable(text);
        if (!clean) return;
        const response = await fetchImpl(`${settings.voiceUrl}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean }),
          signal,
        });
        if (!response.ok) throw new Error(`Synthèse vocale : HTTP ${response.status}`);
        const pcm = Buffer.from(await response.arrayBuffer());
        if (signal.aborted || closed || !pcm.length) return;
        const durationMs = pcm.length / BYTES_PER_MS;
        playbackUntil = Math.max(playbackUntil, Date.now()) + durationMs;
        const chunk = 16_000; // 0,5 s
        for (let offset = 0; offset < pcm.length; offset += chunk)
          notify({ type: 'assistant_speech', pcm: pcm.subarray(offset, offset + chunk) });
      };

      const transcribe = async (pcm: Buffer, signal: AbortSignal): Promise<string> => {
        const response = await fetchImpl(`${settings.voiceUrl}/stt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(pcm),
          signal,
        });
        if (!response.ok) throw new Error(`Transcription : HTTP ${response.status}`);
        const data = (await response.json()) as { text?: string };
        return String(data.text ?? '').trim();
      };

      const tools = () =>
        config.tools.map((tool) => ({
          type: 'function' as const,
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));

      const runTool = (name: string, args: string) =>
        new Promise<string>((resolve) => {
          const id = nextId('call');
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve(JSON.stringify({ error: 'Délai de l’outil dépassé.' }));
          }, 60_000);
          timer.unref?.();
          pending.set(id, { resolve, timer });
          notify({ type: 'tool_call', id, name, arguments: args || '{}' });
        });

      /** Un appel au modèle, en flux : la voix démarre dès la première phrase. */
      const complete = async (signal: AbortSignal, speakText: boolean) => {
        const messages: ChatMessage[] = [
          { role: 'system', content: config.instructions },
          ...history.slice(-MAX_HISTORY),
        ];
        const response = await fetchImpl(`${settings.llmBaseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify({
            model: settings.llmModel,
            stream: true,
            temperature: 0.4,
            messages,
            ...(config.tools.length ? { tools: tools() } : {}),
          }),
        });
        if (!response.ok || !response.body)
          throw new Error(`Modèle local : HTTP ${response.status}`);
        let text = '';
        let pendingSpeech = '';
        let speech = Promise.resolve();
        const calls = new Map<number, { id: string; name: string; args: string }>();
        const queueSpeech = (final: boolean) => {
          if (!speakText) return;
          const { sentences, rest } = takeSentences(pendingSpeech, final);
          pendingSpeech = rest;
          for (const sentence of sentences) {
            if (!busy) continue;
            notify({ type: 'state', state: 'speaking' });
            speech = speech.then(() => speak(sentence, signal));
          }
        };
        const decoder = new TextDecoder();
        let buffered = '';
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (signal.aborted) break;
          buffered += decoder.decode(chunk, { stream: true });
          let newline: number;
          while ((newline = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let data: {
              choices?: {
                delta?: {
                  content?: string | null;
                  tool_calls?: {
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }[];
                };
              }[];
            };
            try {
              data = JSON.parse(payload);
            } catch {
              continue;
            }
            const delta = data.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.content) {
              text += delta.content;
              pendingSpeech += delta.content;
              queueSpeech(false);
            }
            for (const call of delta.tool_calls ?? []) {
              const index = call.index ?? 0;
              const current = calls.get(index) ?? {
                id: call.id ?? nextId('tool'),
                name: '',
                args: '',
              };
              if (call.id) current.id = call.id;
              if (call.function?.name) current.name += call.function.name;
              if (call.function?.arguments) current.args += call.function.arguments;
              calls.set(index, current);
            }
          }
        }
        queueSpeech(true);
        await speech;
        return {
          text: text.replace(/<think>[\s\S]*?<\/think>/gu, '').trim(),
          calls: [...calls.values()],
        };
      };

      const respond = async (signal: AbortSignal) => {
        notify({ type: 'state', state: 'thinking' });
        const startMs = elapsed();
        let spoken = '';
        for (let round = 0; round < MAX_TOOL_ROUNDS && !signal.aborted; round++) {
          const { text, calls } = await complete(signal, true);
          if (text) spoken += (spoken ? ' ' : '') + text;
          if (!calls.length) {
            if (text) history.push({ role: 'assistant', content: text });
            break;
          }
          history.push({
            role: 'assistant',
            content: text || null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.args || '{}' },
            })),
          });
          notify({ type: 'state', state: 'thinking' });
          for (const call of calls) {
            const output = await runTool(call.name, call.args);
            history.push({ role: 'tool', tool_call_id: call.id, content: output.slice(0, 12_000) });
          }
        }
        if (spoken && !signal.aborted)
          notify({
            type: 'assistant_transcript',
            id: nextId('assistant'),
            text: spoken,
            startMs,
            endMs: elapsed(),
          });
      };

      const finishTurn = () => {
        busy = false;
        turn = null;
        const wait = Math.max(0, playbackUntil - Date.now());
        setTimeout(() => {
          if (closed || busy) return;
          notify({ type: 'turn_completed' });
          notify({ type: 'state', state: 'listening' });
        }, wait).unref?.();
      };

      const handleUtterance = (pcm: Buffer) => {
        if (closed || busy) return;
        busy = true;
        const controller = new AbortController();
        turn = controller;
        const startMs = Math.max(0, elapsed() - pcm.length / BYTES_PER_MS);
        void (async () => {
          try {
            notify({ type: 'state', state: 'thinking' });
            const text = await transcribe(pcm, controller.signal);
            if (!text || controller.signal.aborted) return;
            notify({
              type: 'user_transcript',
              id: nextId('user'),
              text,
              startMs,
              endMs: elapsed(),
            });
            history.push({ role: 'user', content: text });
            await respond(controller.signal);
          } catch (error) {
            if (!controller.signal.aborted)
              notify({
                type: 'error',
                code: 'local_voice_failed',
                message: error instanceof Error ? error.message : String(error),
              });
          } finally {
            finishTurn();
          }
        })();
      };

      const vad = new EnergyVad(handleUtterance);

      const close = async () => {
        if (closed) return;
        turn?.abort();
        for (const call of pending.values()) {
          clearTimeout(call.timer);
          call.resolve(JSON.stringify({ error: 'Session clôturée.' }));
        }
        pending.clear();
        closed = true;
        clearTimeout(maximumDuration);
        emit({ type: 'closed' });
      };

      // Le service vocal doit répondre avant d'ouvrir la conversation.
      const health = await fetchImpl(`${settings.voiceUrl}/health`).catch(() => null);
      if (!health?.ok) throw new Error('Service vocal local injoignable.');

      notify({ type: 'connected', id: nextId('local') });
      const maximumDuration = setTimeout(() => void close(), LOCAL_MAX_SESSION_MS);
      maximumDuration.unref?.();

      // Accueil : phrase imposée, ou phrase générée par le modèle.
      if (config.welcomeMessage || config.welcomeInstructions) {
        busy = true;
        const controller = new AbortController();
        turn = controller;
        void (async () => {
          try {
            if (config.welcomeMessage) {
              notify({ type: 'state', state: 'speaking' });
              await speak(config.welcomeMessage, controller.signal);
              history.push({ role: 'assistant', content: config.welcomeMessage });
            } else if (config.welcomeInstructions) {
              history.push({ role: 'user', content: config.welcomeInstructions });
              await respond(controller.signal);
              history.splice(0, 1);
            }
          } catch {
            // L'accueil est facultatif.
          } finally {
            finishTurn();
          }
        })();
      } else notify({ type: 'state', state: 'listening' });

      return {
        audio(pcm) {
          if (closed) return;
          // Pendant que Cornelius parle, le micro entend le haut-parleur : on l'ignore.
          if (busy || Date.now() < playbackUntil + ECHO_GUARD_MS) {
            vad.reset();
            return;
          }
          vad.push(pcm);
        },
        result(id, output) {
          const call = pending.get(id);
          if (!call) return;
          clearTimeout(call.timer);
          pending.delete(id);
          call.resolve(output);
        },
        async update(next) {
          config = next;
        },
        close,
      };
    },
  };
}
