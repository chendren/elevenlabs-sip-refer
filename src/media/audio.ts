/**
 * Audio I/O bridge using sox (Sound eXchange).
 *
 * Key change: sox handles u-law encoding/decoding natively.
 * No JavaScript G.711 codec in the path — sox reads/writes u-law directly.
 *
 * Speaker: raw u-law 8kHz 8-bit mono → sox → speaker
 * Mic:     mic → sox → raw u-law 8kHz 8-bit mono
 *
 * Requires: brew install sox
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class AudioBridge extends EventEmitter {
  private micProcess?: ChildProcess;
  private speakerProcess?: ChildProcess;
  private active = false;
  private soxAvailable = false;
  // Jitter buffer: accumulate initial audio before feeding sox
  private jitterQueue: Buffer[] = [];
  private jitterReady = false;
  private readonly JITTER_FRAMES = 8; // 160ms @ 20ms/frame

  constructor() {
    super();
  }

  /** Check if sox is available */
  async checkSox(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('which', ['sox']);
      proc.on('close', (code) => {
        this.soxAvailable = code === 0;
        resolve(this.soxAvailable);
      });
      proc.on('error', () => {
        this.soxAvailable = false;
        resolve(false);
      });
    });
  }

  /** Start capturing microphone audio — outputs raw u-law bytes */
  async startMicrophone(): Promise<void> {
    if (!this.soxAvailable) {
      console.log('[Audio] Sox not available — running in silence mode (no mic input)');
      return;
    }

    this.active = true;

    // sox captures from mic and outputs raw u-law 8kHz mono
    this.micProcess = spawn('sox', [
      '-q',              // quiet — suppress progress bar
      '-d',              // default audio device (microphone)
      '-t', 'raw',       // raw output format
      '-r', '8000',      // 8000 Hz sample rate (G.711 standard)
      '-e', 'mu-law',    // u-law encoding (native sox conversion)
      '-b', '8',         // 8-bit samples
      '-c', '1',         // mono
      '-',               // output to stdout
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    this.micProcess.stdout?.on('data', (chunk: Buffer) => {
      if (!this.active) return;
      // Already u-law — send directly to RTP
      this.emit('audio', chunk);
    });

    this.micProcess.on('error', (err) => {
      console.error('[Audio] Mic error:', err.message);
    });

    this.micProcess.on('close', () => {
      if (this.active) console.log('[Audio] Microphone stopped');
    });

    console.log('[Audio] Microphone started (mic → sox mu-law → RTP)');
  }

  /** Start speaker output — accepts raw u-law bytes */
  async startSpeaker(): Promise<void> {
    if (!this.soxAvailable) {
      console.log('[Audio] Sox not available — running in silence mode (no speaker output)');
      return;
    }

    this.active = true;

    // sox accepts raw u-law 8kHz mono and plays to speaker
    this.speakerProcess = spawn('sox', [
      '-q',              // quiet — suppress progress bar (prevents event loop flood)
      '-t', 'raw',       // raw input format
      '-r', '8000',      // 8000 Hz
      '-e', 'mu-law',    // u-law encoding (sox decodes natively)
      '-b', '8',         // 8-bit samples
      '-c', '1',         // mono
      '-',               // input from stdin
      '-d',              // default audio device (speaker)
      '--buffer', '640', // 80ms output buffer for low-latency
    ], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    this.speakerProcess.on('error', (err) => {
      console.error('[Audio] Speaker error:', err.message);
    });

    this.speakerProcess.on('close', () => {
      if (this.active) console.log('[Audio] Speaker stopped');
    });

    console.log('[Audio] Speaker started (RTP → sox mu-law → speaker)');
  }

  /** Play u-law audio data through the speaker — writes raw bytes, sox decodes */
  playAudio(ulawData: Buffer): void {
    if (!this.speakerProcess?.stdin?.writable) return;

    // Jitter buffer: accumulate initial frames before starting playback
    // This prevents sox from starving on the first few packets
    if (!this.jitterReady) {
      this.jitterQueue.push(ulawData);
      if (this.jitterQueue.length >= this.JITTER_FRAMES) {
        this.jitterReady = true;
        const burst = Buffer.concat(this.jitterQueue);
        this.jitterQueue = [];
        this.speakerProcess.stdin.write(burst);
      }
      return;
    }

    this.speakerProcess.stdin.write(ulawData);
  }

  /** Reset jitter buffer (call between calls) */
  resetJitter(): void {
    this.jitterQueue = [];
    this.jitterReady = false;
  }

  /** Stop all audio */
  stop(): void {
    this.active = false;
    if (this.micProcess) {
      this.micProcess.kill('SIGTERM');
      this.micProcess = undefined;
    }
    if (this.speakerProcess) {
      this.speakerProcess.stdin?.end();
      this.speakerProcess.kill('SIGTERM');
      this.speakerProcess = undefined;
    }
  }
}
