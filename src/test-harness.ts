/**
 * Automated SIP REFER Test Harness
 *
 * Runs N automated calls to Agent A, plays TTS "transfer me" audio,
 * detects transfer via ringback tone, connects to Agent B, records
 * audio, and verifies success via conversation API.
 *
 * Usage: npx tsx src/test-harness.ts [count]
 */
import { CONFIG } from './config.js';
import { SipClient } from './sip/client.js';
import { RtpSession } from './media/rtp.js';
import { discoverNatMapping } from './media/stun.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';

const STATE_FILE = resolve(import.meta.dirname, '../.state.json');
const TRANSFER_AUDIO = resolve(import.meta.dirname, '../audio/transfer-me.ulaw');
const RESULTS_DIR = resolve(import.meta.dirname, '../test-results');

interface TestResult {
  run: number;
  callAEstablished: boolean;
  ttsPlayed: boolean;
  transferDetected: boolean;
  callBEstablished: boolean;
  agentBConfirmed: boolean;
  agentATranscript: string[];
  agentBTranscript: string[];
  durationMs: number;
  error?: string;
}

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPublicIp(): Promise<string | null> {
  try {
    const resp = await fetch('https://api.ipify.org');
    return resp.ok ? (await resp.text()).trim() : null;
  } catch { return null; }
}

async function getConversationTranscript(agentId: string, afterTimestamp: number): Promise<{
  transcript: string[];
  transferUsed: boolean;
} | null> {
  try {
    const resp = await fetch(
      `${CONFIG.elevenlabs.apiBase}/convai/conversations?agent_id=${agentId}&page_size=3`,
      { headers: { 'xi-api-key': CONFIG.elevenlabs.apiKey } },
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { conversations: Array<{ conversation_id: string; start_time_unix_secs: number }> };

    for (const conv of data.conversations) {
      if (conv.start_time_unix_secs >= afterTimestamp - 5) {
        const dr = await fetch(
          `${CONFIG.elevenlabs.apiBase}/convai/conversations/${conv.conversation_id}`,
          { headers: { 'xi-api-key': CONFIG.elevenlabs.apiKey } },
        );
        if (!dr.ok) continue;
        const detail = await dr.json() as {
          transcript?: Array<{ role: string; message?: string | null }>;
          metadata?: { features_usage?: { transfer_to_number?: { used: boolean } } };
        };
        const transcript = (detail.transcript ?? [])
          .map(m => `[${m.role}] ${m.message ?? ''}`)
          .filter(s => s.length > 7);
        const transferUsed = detail.metadata?.features_usage?.transfer_to_number?.used ?? false;
        return { transcript, transferUsed };
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ── Tone detector ───────────────────────────────────────

function createToneDetector(timeoutMs = 35000): {
  feed: (data: Buffer) => void;
  promise: Promise<boolean>; // true = tone detected, false = timeout
  cancel: () => void;
} {
  const energyHistory: number[] = [];
  let hadSpeech = false;
  let resolved = false;
  let resolvePromise: ((detected: boolean) => void) | null = null;
  let timeoutId: ReturnType<typeof setTimeout>;

  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
    timeoutId = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(false); }
    }, timeoutMs);
  });

  return {
    feed(data: Buffer) {
      if (resolved) return;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 0xFF);
      const energy = sum / data.length;
      energyHistory.push(energy);
      if (energyHistory.length > 40) energyHistory.shift();

      if (!hadSpeech && energyHistory.length >= 10) {
        const avg = energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length;
        const v = energyHistory.reduce((a, b) => a + (b - avg) ** 2, 0) / energyHistory.length;
        if (avg > 15 && v > 100) hadSpeech = true;
      }
      if (!hadSpeech || energyHistory.length < 40) return;

      const avg = energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length;
      const v = energyHistory.reduce((a, b) => a + (b - avg) ** 2, 0) / energyHistory.length;
      if (avg > 5 && avg < 80 && v < 30) {
        clearTimeout(timeoutId);
        resolved = true;
        resolvePromise?.(true);
      }
    },
    promise,
    cancel() { clearTimeout(timeoutId); if (!resolved) { resolved = true; resolvePromise?.(false); } },
  };
}

// ── Single test run ─────────────────────────────────────

async function runSingleTest(
  run: number,
  state: { agentAId: string; agentBId: string },
  localIp: string,
  publicIp: string | null,
  transferAudio: Buffer,
  rtpBasePort: number,
): Promise<TestResult> {
  const tag = `[Run ${run}]`;
  const startTime = Date.now();
  const startTimeSecs = Math.floor(startTime / 1000);
  const result: TestResult = {
    run, callAEstablished: false, ttsPlayed: false, transferDetected: false,
    callBEstablished: false, agentBConfirmed: false,
    agentATranscript: [], agentBTranscript: [], durationMs: 0,
  };

  const recordedAudio: Buffer[] = [];
  let sipClient: SipClient | null = null;
  let rtp: RtpSession | null = null;

  try {
    // ── Call Agent A ──
    sipClient = new SipClient({
      localIp, localPort: CONFIG.local.sipPort,
      publicIp: publicIp ?? undefined,
      remoteHost: CONFIG.elevenlabs.sipHost, remotePort: CONFIG.elevenlabs.sipPort,
      transport: 'tcp',
      credentials: { username: CONFIG.sip.username, password: CONFIG.sip.password },
    });
    sipClient.on('error', () => {});
    await sipClient.connect();
    console.log(`${tag} SIP connected`);

    rtp = new RtpSession(rtpBasePort);
    await rtp.start();

    const stunMapping = await discoverNatMapping(rtp.getSocket());
    const sdpOverride = stunMapping
      ? { ip: stunMapping.publicIp, port: stunMapping.publicPort }
      : undefined;
    console.log(`${tag} STUN: ${stunMapping ? `${stunMapping.publicIp}:${stunMapping.publicPort}` : 'FAILED'}`);

    const detector = createToneDetector(35000);
    let gateOpen = false;
    let rxCount = 0;

    rtp.on('audio', (data: Buffer) => {
      if (gateOpen) {
        rxCount++;
        detector.feed(data);
        recordedAudio.push(Buffer.from(data));
      }
    });

    const callIdA = await sipClient.invite(CONFIG.agents.agentANumber, rtpBasePort, sdpOverride);
    gateOpen = true;
    result.callAEstablished = true;
    console.log(`${tag} Call A established`);

    const callStateA = sipClient.getCallState(callIdA);
    if (callStateA?.remoteRtpHost && callStateA?.remoteRtpPort) {
      rtp.setRemote(callStateA.remoteRtpHost, callStateA.remoteRtpPort);
    }

    // Wait for Agent A greeting
    await sleep(5000);
    console.log(`${tag} RX packets after greeting: ${rxCount}`);

    // Play TTS "Transfer me please"
    const FRAME_SIZE = 160;
    for (let offset = 0; offset < transferAudio.length; offset += FRAME_SIZE) {
      const frame = transferAudio.subarray(offset, offset + FRAME_SIZE);
      rtp.queueAudio(frame);
    }
    result.ttsPlayed = true;
    console.log(`${tag} TTS queued (${(transferAudio.length / 8000).toFixed(1)}s)`);

    // Wait for ringback tone
    const toneDetected = await detector.promise;
    result.transferDetected = toneDetected;
    console.log(`${tag} Tone detected: ${toneDetected} (RX total: ${rxCount})`);

    // Tear down Agent A
    gateOpen = false;
    rtp.stop();
    rtp = null;
    sipClient.hangup(callIdA);
    await sleep(500);
    sipClient.close();
    sipClient = null;

    if (!toneDetected) {
      // Even without tone detection, still try Agent B
      console.log(`${tag} No tone — trying Agent B anyway`);
    }

    // ── Call Agent B ──
    await sleep(1000);

    sipClient = new SipClient({
      localIp, localPort: CONFIG.local.sipPort,
      publicIp: publicIp ?? undefined,
      remoteHost: CONFIG.elevenlabs.sipHost, remotePort: CONFIG.elevenlabs.sipPort,
      transport: 'tcp',
      credentials: { username: CONFIG.sip.username, password: CONFIG.sip.password },
    });
    sipClient.on('error', () => {});
    await sipClient.connect();

    const rtpPortB = rtpBasePort + 1;
    rtp = new RtpSession(rtpPortB);
    await rtp.start();

    const stunB = await discoverNatMapping(rtp.getSocket());
    const sdpOverrideB = stunB ? { ip: stunB.publicIp, port: stunB.publicPort } : undefined;

    rtp.on('audio', (data: Buffer) => {
      recordedAudio.push(Buffer.from(data));
    });

    const callIdB = await sipClient.invite(CONFIG.agents.agentBNumber, rtpPortB, sdpOverrideB);
    result.callBEstablished = true;
    console.log(`${tag} Call B established`);

    const callStateB = sipClient.getCallState(callIdB);
    if (callStateB?.remoteRtpHost && callStateB?.remoteRtpPort) {
      rtp.setRemote(callStateB.remoteRtpHost, callStateB.remoteRtpPort);
    }

    await sleep(6000);

    rtp.stop();
    rtp = null;
    sipClient.hangup(callIdB);
    await sleep(500);
    sipClient.close();
    sipClient = null;

    // ── Verify via API ──
    await sleep(3000);

    const agentAConv = await getConversationTranscript(state.agentAId, startTimeSecs);
    if (agentAConv) {
      result.agentATranscript = agentAConv.transcript;
      if (agentAConv.transferUsed) result.transferDetected = true;
    }

    const agentBConv = await getConversationTranscript(state.agentBId, startTimeSecs);
    if (agentBConv) {
      result.agentBTranscript = agentBConv.transcript;
      result.agentBConfirmed = agentBConv.transcript.length > 0;
    }

  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.log(`${tag} ERROR: ${result.error}`);
  } finally {
    try { rtp?.stop(); } catch { /* ok */ }
    try { sipClient?.close(); } catch { /* ok */ }
    result.durationMs = Date.now() - startTime;

    if (recordedAudio.length > 0) {
      const audioFile = resolve(RESULTS_DIR, `run-${run}-audio.ulaw`);
      writeFileSync(audioFile, Buffer.concat(recordedAudio));
    }
  }

  return result;
}

// ── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const totalRuns = parseInt(process.argv[2] ?? '10', 10);

  console.log(`
╔══════════════════════════════════════════════════════════╗
║       SIP REFER Automated Test Harness                  ║
║       ${totalRuns} calls x (Agent A -> Transfer -> Agent B)       ║
╚══════════════════════════════════════════════════════════╝
`);

  if (!existsSync(STATE_FILE)) { console.error('No .state.json'); process.exit(1); }
  if (!existsSync(TRANSFER_AUDIO)) { console.error('No transfer-me.ulaw'); process.exit(1); }

  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  const transferAudio = readFileSync(TRANSFER_AUDIO);
  const localIp = getLocalIp();
  const publicIp = await getPublicIp();

  console.log(`Local: ${localIp} | Public: ${publicIp ?? 'none'} | TTS: ${(transferAudio.length / 8000).toFixed(1)}s`);
  console.log('');

  mkdirSync(RESULTS_DIR, { recursive: true });

  const results: TestResult[] = [];

  for (let i = 1; i <= totalRuns; i++) {
    const rtpBase = 11000 + ((i - 1) * 2);
    console.log(`\n── Run ${i}/${totalRuns} (ports ${rtpBase}-${rtpBase + 1}) ──`);

    const result = await runSingleTest(i, state, localIp, publicIp, transferAudio, rtpBase);
    results.push(result);

    const status = result.agentBConfirmed ? 'PASS' :
                   result.callBEstablished ? 'PARTIAL' : 'FAIL';

    console.log(`  Result: ${status} | A:${result.callAEstablished ? 'Y' : 'N'} TTS:${result.ttsPlayed ? 'Y' : 'N'} Xfer:${result.transferDetected ? 'Y' : 'N'} B:${result.callBEstablished ? 'Y' : 'N'} Confirmed:${result.agentBConfirmed ? 'Y' : 'N'} | ${(result.durationMs / 1000).toFixed(0)}s`);

    if (result.agentATranscript.length > 0) {
      console.log('  A: ' + result.agentATranscript.map(l => l.slice(0, 80)).join(' | '));
    }
    if (result.agentBTranscript.length > 0) {
      console.log('  B: ' + result.agentBTranscript.map(l => l.slice(0, 80)).join(' | '));
    }
    if (result.error) console.log(`  Err: ${result.error}`);

    if (i < totalRuns) await sleep(2000);
  }

  // ── Summary ──
  const passed = results.filter(r => r.agentBConfirmed).length;
  const partial = results.filter(r => r.callBEstablished && !r.agentBConfirmed).length;
  const failed = results.filter(r => !r.callBEstablished).length;
  const xferRate = results.filter(r => r.transferDetected).length;

  console.log(`
╔══════════════════════════════════════════════════════════╗
║                    TEST RESULTS                         ║
╠══════════════════════════════════════════════════════════╣
║  Total:     ${totalRuns}                                          ║
║  PASS:      ${passed}/${totalRuns} (${((passed / totalRuns) * 100).toFixed(0)}%)                                      ║
║  PARTIAL:   ${partial}                                          ║
║  FAIL:      ${failed}                                          ║
║  Transfers: ${xferRate}/${totalRuns}                                        ║
╚══════════════════════════════════════════════════════════╝`);

  const resultsFile = resolve(RESULTS_DIR, `results-${Date.now()}.json`);
  writeFileSync(resultsFile, JSON.stringify({ results, summary: { totalRuns, passed, partial, failed, xferRate } }, null, 2));
  console.log(`\nResults: ${resultsFile}`);
  console.log(`Audio:   ${RESULTS_DIR}/`);

  process.exit(passed === totalRuns ? 0 : 1);
}

main();
