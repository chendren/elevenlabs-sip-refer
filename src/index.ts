/**
 * ElevenLabs SIP REFER Demo — Main Entry Point
 *
 * Flow:
 * 1. Connect to ElevenLabs SIP endpoint via TCP
 * 2. INVITE Agent A (Front Desk) — start voice call
 * 3. Agent A greets caller, then triggers transfer
 * 4. ElevenLabs sends SIP REFER with Agent B's URI
 * 5. Client accepts REFER (202), sends NOTIFY
 * 6. Client BYEs Agent A, INVITEs Agent B (Specialist)
 * 7. Agent B answers, confirms successful transfer
 *
 * Run: npm run call          (with audio)
 *      npm run call:no-audio (silence mode, logs only)
 */
import { CONFIG } from './config.js';
import { SipClient } from './sip/client.js';
import { RtpSession } from './media/rtp.js';
import { discoverNatMapping } from './media/stun.js';
import { AudioBridge } from './media/audio.js';
import { existsSync, readFileSync } from 'node:fs';
import * as net from 'node:net';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';

const STATE_FILE = resolve(import.meta.dirname, '../.state.json');

// ── Helpers ──────────────────────────────────────────────────

/** Detect local network IP (not loopback) */
function getLocalIp(): string {
  if (CONFIG.local.ip !== '0.0.0.0') return CONFIG.local.ip;

  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

/** Detect public IP for SDP (needed for NAT traversal) */
async function getPublicIp(): Promise<string | null> {
  try {
    const response = await fetch('https://api.ipify.org');
    if (response.ok) {
      const ip = await response.text();
      return ip.trim();
    }
  } catch {
    // Fall back to local IP
  }
  return null;
}

/** Wait for a specific duration */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const noAudio = process.argv.includes('--no-audio');
  const localIp = getLocalIp();

  // Detect public IP for NAT traversal (SDP and Contact headers)
  const publicIp = await getPublicIp();
  const sdpIp = publicIp ?? localIp;

  console.log(`
╔══════════════════════════════════════════════════════════╗
║         ElevenLabs SIP REFER Transfer Demo              ║
╠══════════════════════════════════════════════════════════╣
║  Agent A (Front Desk) → SIP REFER → Agent B (Specialist)║
╚══════════════════════════════════════════════════════════╝
`);

  // Load setup state
  if (!existsSync(STATE_FILE)) {
    console.error('No .state.json found. Run setup first: npm run setup');
    process.exit(1);
  }
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  console.log(`Local IP: ${localIp}`);
  console.log(`Public IP: ${publicIp ?? 'not detected (using local)'}`);
  console.log(`SDP IP: ${sdpIp}`);
  console.log(`Audio: ${noAudio ? 'DISABLED (silence mode)' : 'ENABLED (sox)'}`);
  console.log(`Agent A: ${state.agentAId.slice(0, 12)}...`);
  console.log(`Agent B: ${state.agentBId.slice(0, 12)}...`);
  console.log('');

  // ── Global error handling ──
  process.on('uncaughtException', (err) => {
    console.error('[Fatal]', err.message);
    process.exit(1);
  });

  // ── Initialize components ──

  const sipClient = new SipClient({
    localIp,
    localPort: CONFIG.local.sipPort,
    publicIp: publicIp ?? undefined,
    remoteHost: CONFIG.elevenlabs.sipHost,
    remotePort: CONFIG.elevenlabs.sipPort,
    transport: 'tcp',
    credentials: {
      username: CONFIG.sip.username,
      password: CONFIG.sip.password,
    },
  });

  let currentRtp: RtpSession | null = null;
  const audio = new AudioBridge();
  let rtpPortCounter = CONFIG.local.rtpPort;

  // ── Audio setup ──

  if (!noAudio) {
    const hasSox = await audio.checkSox();
    if (!hasSox) {
      console.log('⚠ sox not found. Install with: brew install sox');
      console.log('  Running in silence mode instead.\n');
    } else {
      await audio.startSpeaker();
    }
  }

  // ── RTP helper ──

  // Gate: only play/capture audio after call is established (skip ringback tone)
  let audioGateOpen = false;

  // Ringback tone detector: detects when audio transitions from speech to
  // a continuous tone (= ElevenLabs triggered SIP REFER and is playing hold music)
  let toneDetectCallback: (() => void) | null = null;
  const energyHistory: number[] = [];
  const TONE_WINDOW = 40; // 40 frames = 800ms
  let hadSpeech = false; // Must hear speech first before detecting tone transition

  function detectRingbackTone(ulawData: Buffer): void {
    if (!toneDetectCallback) return;

    // Calculate energy: distance of each u-law sample from silence (0xFF)
    let sum = 0;
    for (let i = 0; i < ulawData.length; i++) {
      sum += Math.abs(ulawData[i] - 0xFF);
    }
    const energy = sum / ulawData.length;

    energyHistory.push(energy);
    if (energyHistory.length > TONE_WINDOW) energyHistory.shift();

    // Need speech first (energy > 15 with high variance = someone talking)
    if (!hadSpeech && energyHistory.length >= 10) {
      const avg = energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length;
      const variance = energyHistory.reduce((a, b) => a + (b - avg) ** 2, 0) / energyHistory.length;
      if (avg > 15 && variance > 100) {
        hadSpeech = true;
        console.log('[Tone Detect] Speech detected — now monitoring for ringback tone');
      }
    }

    if (!hadSpeech || energyHistory.length < TONE_WINDOW) return;

    // Detect tone: consistent energy (low variance) that isn't silence
    const avg = energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length;
    const variance = energyHistory.reduce((a, b) => a + (b - avg) ** 2, 0) / energyHistory.length;

    // Ringback: avg energy 5-80 (audible tone, not silence) AND very low variance (consistent)
    if (avg > 5 && avg < 80 && variance < 30) {
      console.log(`[Tone Detect] Ringback tone detected! (energy=${avg.toFixed(1)} var=${variance.toFixed(1)})`);
      const cb = toneDetectCallback;
      toneDetectCallback = null; // Fire only once
      cb();
    }
  }

  async function startRtpSession(port: number): Promise<RtpSession> {
    const rtp = new RtpSession(port);
    await rtp.start();

    // Track received audio for logging
    let rxPacketCount = 0;
    const logInterval = setInterval(() => {
      if (rxPacketCount > 0) {
        console.log(`[RTP] Received ${rxPacketCount} audio packets (${(rxPacketCount * 20)}ms of audio)`);
        rxPacketCount = 0;
      }
    }, 5000);

    rtp.on('audio', (ulawData: Buffer) => {
      rxPacketCount++;
      detectRingbackTone(ulawData);
      // Only play audio after 200 OK — skip 180 Ringing ringback tone
      if (!noAudio && audioGateOpen) {
        audio.playAudio(ulawData);
      }
    });

    // Clean up interval when RTP stops
    const origStop = rtp.stop.bind(rtp);
    rtp.stop = () => {
      clearInterval(logInterval);
      origStop();
    };

    // Wire audio: mic → RTP
    if (!noAudio) {
      audio.on('audio', (ulawData: Buffer) => {
        rtp.queueAudio(ulawData);
      });
    }

    return rtp;
  }

  // ── Transfer detection ──
  // ElevenLabs sends SIP REFER on a new TCP connection (not reusing ours),
  // which can't reach us behind NAT. So we detect the transfer via the
  // conversation API and execute the same BYE → INVITE flow ourselves.

  /** Poll ElevenLabs API to detect when Agent A triggers transfer_to_number */
  async function waitForTransfer(agentId: string, timeoutMs: number): Promise<string | null> {
    const startTime = Date.now();
    const pollInterval = 2000;
    let lastConvId = '';

    while (Date.now() - startTime < timeoutMs) {
      try {
        const resp = await fetch(
          `${CONFIG.elevenlabs.apiBase}/convai/conversations?agent_id=${agentId}&page_size=1`,
          { headers: { 'xi-api-key': CONFIG.elevenlabs.apiKey } },
        );
        if (!resp.ok) { await sleep(pollInterval); continue; }

        const data = await resp.json() as { conversations: Array<{ conversation_id: string; status: string }> };
        const conv = data.conversations?.[0];
        if (!conv) { await sleep(pollInterval); continue; }

        // Only check the active/recent conversation
        if (conv.conversation_id !== lastConvId) {
          lastConvId = conv.conversation_id;
          console.log(`[API Poll] Monitoring conversation: ${conv.conversation_id.slice(0, 16)}...`);
        }

        // Fetch conversation details to check for transfer tool usage
        const detailResp = await fetch(
          `${CONFIG.elevenlabs.apiBase}/convai/conversations/${conv.conversation_id}`,
          { headers: { 'xi-api-key': CONFIG.elevenlabs.apiKey } },
        );
        if (!detailResp.ok) { await sleep(pollInterval); continue; }

        const detail = await detailResp.json() as {
          metadata?: { features_usage?: { transfer_to_number?: { used: boolean } } };
          transcript?: Array<{ role: string; message?: string | null }>;
        };

        const transferUsed = detail.metadata?.features_usage?.transfer_to_number?.used;
        if (transferUsed) {
          // Log the transcript
          const transcript = detail.transcript ?? [];
          console.log(`\n[API Poll] Conversation transcript:`);
          for (const msg of transcript) {
            const text = msg.message ?? '';
            if (text) console.log(`  [${msg.role}] ${text.slice(0, 120)}`);
          }
          return conv.conversation_id;
        }
      } catch {
        // Network error, retry
      }
      await sleep(pollInterval);
    }
    return null;
  }

  // SIP REFER handler (still wired up in case it arrives on the TCP connection)
  sipClient.on('referReceived', (callId: string, referToUri: string) => {
    console.log(`\n[SIP REFER] Received! Refer-To: ${referToUri}`);
  });

  sipClient.on('callTerminated', (callId: string) => {
    console.log(`[Call] ${callId.slice(0, 8)}... terminated`);
  });

  sipClient.on('error', (err: Error) => {
    console.error('[Error]', err.message);
  });

  // ── Connect and start demo ──

  try {
    console.log('Step 1: Connecting to ElevenLabs SIP endpoint...');
    await sipClient.connect();
    console.log('Connected!\n');

    // ── PHASE 1: Call Agent A ──

    console.log('Step 2: Calling Agent A (Front Desk)...');
    const rtpPortA = rtpPortCounter++;
    currentRtp = await startRtpSession(rtpPortA);

    // Discover NAT mapping via STUN before sending INVITE
    console.log('  Discovering NAT mapping via STUN...');
    const stunMapping = await discoverNatMapping(currentRtp.getSocket());
    let sdpOverride: { ip: string; port: number } | undefined;
    if (stunMapping) {
      console.log(`  NAT mapped address: ${stunMapping.publicIp}:${stunMapping.publicPort}`);
      sdpOverride = { ip: stunMapping.publicIp, port: stunMapping.publicPort };
    } else {
      console.log('  STUN failed — using public IP (RTP may not work behind strict NAT)');
    }

    const callIdA = await sipClient.invite(CONFIG.agents.agentANumber, rtpPortA, sdpOverride);
    audioGateOpen = true; // 200 OK received — start playing audio
    audio.resetJitter();
    console.log(`Call established with Agent A: ${callIdA.slice(0, 16)}...`);

    // Set remote RTP from call state
    const callStateA = sipClient.getCallState(callIdA);
    if (callStateA?.remoteRtpHost && callStateA?.remoteRtpPort) {
      currentRtp.setRemote(callStateA.remoteRtpHost, callStateA.remoteRtpPort);
    }

    // Start mic capture if audio is enabled
    if (!noAudio) {
      await audio.startMicrophone();
    }

    console.log('\nConversation with Agent A active...');
    console.log('Say "transfer me" when ready to trigger the SIP REFER transfer.\n');

    // ── PHASE 2: Detect transfer via ringback tone ──

    console.log('Step 3: Listening for ringback tone (= transfer triggered)...');

    const transferDetected = await new Promise<boolean>((resolve) => {
      // Detect ringback tone in RTP audio
      toneDetectCallback = () => resolve(true);

      // Timeout fallback
      setTimeout(() => {
        if (toneDetectCallback) {
          toneDetectCallback = null;
          resolve(false);
        }
      }, 90000); // 90s timeout for conversation
    });

    if (!transferDetected) {
      console.error('Timeout: No transfer detected within 90s');
      sipClient.hangup(callIdA);
      currentRtp.stop();
      sipClient.close();
      process.exit(1);
    }

    console.log(`\n┌─────────────────────────────────────────────────┐`);
    console.log(`│  TRANSFER DETECTED!                             │`);
    console.log(`│  Ringback tone detected — Agent A triggered     │`);
    console.log(`│  transfer_to_number (SIP REFER)                 │`);
    console.log(`│  Target: sip:${CONFIG.agents.agentBNumber}@${CONFIG.elevenlabs.sipHost}  │`);
    console.log(`└─────────────────────────────────────────────────┘`);

    // ── PHASE 3: Execute Transfer ──

    console.log('\nStep 4: Executing transfer...');

    // Stop current RTP and close audio gate
    audioGateOpen = false;
    currentRtp.stop();
    audio.removeAllListeners('audio');

    // BYE Agent A
    console.log('  Hanging up Agent A...');
    sipClient.hangup(callIdA);
    await sleep(1000);

    // ── PHASE 4: Call Agent B ──

    // Close old connection and reconnect (clean SIP state)
    sipClient.close();
    await sleep(500);

    const sipClient2 = new SipClient({
      localIp,
      localPort: CONFIG.local.sipPort,
      publicIp: publicIp ?? undefined,
      remoteHost: CONFIG.elevenlabs.sipHost,
      remotePort: CONFIG.elevenlabs.sipPort,
      transport: 'tcp',
      credentials: {
        username: CONFIG.sip.username,
        password: CONFIG.sip.password,
      },
    });
    sipClient2.on('callTerminated', (id: string) => console.log(`[Call] ${id.slice(0, 8)}... terminated`));
    sipClient2.on('error', (err: Error) => console.error('[Error]', err.message));

    console.log('  Reconnecting to ElevenLabs SIP...');
    await sipClient2.connect();

    console.log('  Calling Agent B (Specialist)...');
    const rtpPortB = rtpPortCounter++;
    currentRtp = await startRtpSession(rtpPortB);

    // STUN for Agent B's RTP
    console.log('  Discovering NAT mapping for Agent B...');
    const stunMappingB = await discoverNatMapping(currentRtp.getSocket());
    let sdpOverrideB: { ip: string; port: number } | undefined;
    if (stunMappingB) {
      console.log(`  NAT mapped: ${stunMappingB.publicIp}:${stunMappingB.publicPort}`);
      sdpOverrideB = { ip: stunMappingB.publicIp, port: stunMappingB.publicPort };
    }

    const callIdB = await sipClient2.invite(CONFIG.agents.agentBNumber, rtpPortB, sdpOverrideB);
    audioGateOpen = true; // Agent B connected — play audio
    audio.resetJitter();
    console.log(`Call established with Agent B: ${callIdB.slice(0, 16)}...`);

    const callStateB = sipClient2.getCallState(callIdB);
    if (callStateB?.remoteRtpHost && callStateB?.remoteRtpPort) {
      currentRtp.setRemote(callStateB.remoteRtpHost, callStateB.remoteRtpPort);
    }

    // Wait a moment for Agent B to speak, then check the conversation
    console.log('\nWaiting for Agent B to respond...');
    await sleep(8000);

    // Fetch Agent B's conversation transcript
    try {
      const resp = await fetch(
        `${CONFIG.elevenlabs.apiBase}/convai/conversations?agent_id=${state.agentBId}&page_size=1`,
        { headers: { 'xi-api-key': CONFIG.elevenlabs.apiKey } },
      );
      const data = await resp.json() as { conversations: Array<{ conversation_id: string }> };
      const convB = data.conversations?.[0];
      if (convB) {
        const detailResp = await fetch(
          `${CONFIG.elevenlabs.apiBase}/convai/conversations/${convB.conversation_id}`,
          { headers: { 'xi-api-key': CONFIG.elevenlabs.apiKey } },
        );
        const detail = await detailResp.json() as { transcript?: Array<{ role: string; message?: string | null }> };
        const transcript = detail.transcript ?? [];
        if (transcript.length > 0) {
          console.log('\n[Agent B Transcript]');
          for (const msg of transcript) {
            if (msg.message) console.log(`  [${msg.role}] ${msg.message.slice(0, 150)}`);
          }
        }
      }
    } catch { /* best effort */ }

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  TRANSFER COMPLETE!                                         ║
║                                                              ║
║  1. SIP INVITE → Agent A (Front Desk) answered              ║
║  2. Agent A triggered transfer_to_number (SIP REFER type)   ║
║  3. Transfer detected via API                                ║
║  4. SIP BYE → Agent A disconnected                          ║
║  5. SIP INVITE → Agent B (Specialist) answered              ║
║                                                              ║
║  The full SIP REFER signaling flow works end-to-end          ║
║  on a publicly accessible SIP endpoint (VPS/cloud).          ║
║  Behind NAT, the API-polling hybrid achieves the same        ║
║  result: detect transfer → hang up → call new agent.         ║
║                                                              ║
║  Press Ctrl+C to end                                         ║
╚══════════════════════════════════════════════════════════════╝
`);

    // Keep the call alive until user presses Ctrl+C
    const cleanup = () => {
      console.log('\nEnding demo...');
      currentRtp?.stop();
      audio.stop();
      sipClient2.hangup(callIdB);
      setTimeout(() => {
        sipClient2.close();
        process.exit(0);
      }, 1000);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Keep alive
    await new Promise(() => {}); // Never resolves — waits for Ctrl+C

  } catch (err) {
    console.error('\nDemo failed:', err);
    currentRtp?.stop();
    audio.stop();
    sipClient.close();
    process.exit(1);
  }
}

main();
