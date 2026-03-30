# ElevenLabs SIP REFER Transfer Demo

A complete proof-of-concept demonstrating **SIP REFER call transfers** between two ElevenLabs AI voice agents, driven from a local Mac/Linux SIP client with two-way audio.

**20/20 consecutive automated test runs passing at 100% success rate.**

```
Mac SIP Client ──TCP:5060──→ sip.rtc.elevenlabs.io
     │                              │
     │  INVITE Agent A ────────────►│  "Hello! Welcome to the front desk..."
     │  ◄── RTP Audio (G.711) ────►│
     │  "Transfer me please" ──────►│  Agent A invokes transfer_to_number
     │  ◄── Ringback Tone ─────────│  (SIP REFER triggered)
     │  BYE Agent A ───────────────►│
     │  INVITE Agent B ────────────►│  "I'm the specialist. Transfer successful!"
     │  ◄── RTP Audio ────────────►│
     ▼                              ▼
```

## What This Demonstrates

- **Custom SIP stack in TypeScript** — no external SIP dependencies, raw TCP signaling
- **SIP INVITE with digest authentication** against ElevenLabs/LiveKit (realm: LiveKit)
- **Two-way G.711 u-law audio** over RTP/UDP with STUN NAT traversal
- **SIP REFER transfer detection** via real-time RTP ringback tone analysis
- **Automated testing** with TTS-generated audio and conversation API verification
- **ElevenLabs Conversational AI** agent configuration with `transfer_to_number` system tool

## Quick Start

### Prerequisites

- Node.js 20+
- [sox](https://sox.sourceforge.net/) for audio I/O: `brew install sox`
- An [ElevenLabs](https://elevenlabs.io) API key with Conversational AI access

### Setup

```bash
git clone https://github.com/chendren/elevenlabs-sip-refer.git
cd elevenlabs-sip-refer
npm install

# Configure your API key
cp .env.example .env
# Edit .env and set ELEVENLABS_API_KEY

# Provision agents and SIP trunk on ElevenLabs
npm run setup
```

### Interactive Demo

Talk to Agent A, then say **"transfer me"** to trigger the SIP REFER transfer to Agent B:

```bash
npm run call
```

### Automated Test Suite

Run 10 fully automated calls with TTS audio, transfer detection, and verification:

```bash
npm test
```

## Architecture

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **SIP Stack** | `src/sip/` | Custom TypeScript SIP over TCP — parser, builder, transport, client |
| **Media** | `src/media/` | RTP/UDP, G.711 u-law, SDP, STUN NAT discovery, sox audio bridge |
| **Setup** | `src/setup.ts` | Creates ElevenLabs agents + SIP trunk via API |
| **Demo** | `src/index.ts` | Interactive call flow with two-way audio |
| **Test Harness** | `src/test-harness.ts` | Automated N-call test with TTS, recording, verification |

### Call Flow

1. **STUN Discovery** — Sends binding request to `stun.l.google.com:19302` from the RTP UDP socket to discover the NAT-mapped public IP:port
2. **SIP INVITE** — Connects to `sip.rtc.elevenlabs.io:5060` via TCP, sends INVITE with SDP containing the STUN-discovered address
3. **Digest Auth** — Handles 407 challenge (realm: LiveKit), re-sends authenticated INVITE
4. **200 OK + ACK** — Call established, audio gate opens
5. **RTP Audio** — G.711 u-law at 8kHz, 160-byte frames every 20ms, bidirectional
6. **Transfer Trigger** — User says "transfer me" (or TTS plays it in automated mode)
7. **Ringback Detection** — Agent A invokes `transfer_to_number` tool, ElevenLabs plays ringback tone; detected by monitoring RTP energy variance (speech → tone transition)
8. **SIP BYE** — Tears down Agent A call
9. **New SIP INVITE** — Fresh TCP connection + STUN for Agent B
10. **Agent B Confirms** — "I received your transfer from the front desk. The SIP REFER transfer was successful!"

### Transfer Detection

ElevenLabs sends the SIP REFER on a **new TCP connection** to the Contact URI, which is unreachable behind NAT. Instead, transfer is detected in real-time by analyzing the RTP audio stream:

- **Speech phase**: High energy + high variance (someone talking)
- **Ringback phase**: Moderate energy + very low variance (continuous tone)
- When the audio transitions from speech to tone, the transfer has been triggered

On a server with a public IP, the SIP REFER handler in `src/sip/client.ts` would receive the REFER directly via SIP signaling.

## ElevenLabs Configuration

### Agent A (Front Desk)

- LLM: `gpt-4o` (required — `gpt-4o-mini` generates text about tools instead of calling them)
- System tool: `transfer_to_number` with `transfer_type: "sip_refer"`
- Transfer destination: `sip:+<agent-b-number>@sip.rtc.elevenlabs.io`
- Prompt instructs the agent to invoke the tool function, not just say "I'll transfer you"

### Agent B (Specialist)

- LLM: `gpt-4o-mini`
- No tools — confirms the transfer was successful
- First message acknowledges the handoff

### SIP Trunk

- Provider: `sip_trunk`
- Authentication: Digest (username/password configured on inbound trunk)
- Media encryption: `allowed`
- Transport: TCP (port 5060) — UDP is not supported by ElevenLabs

## Audio Pipeline

```
Speaker: RTP u-law bytes → sox -q -e mu-law -r 8000 → speaker
Mic:     mic → sox -q -e mu-law -r 8000 → u-law bytes → RTP
```

Key decisions:
- **sox handles G.711 natively** — no JavaScript codec in the audio path (eliminates static)
- **`-q` flag is mandatory** — without it, sox progress bars flood the Node.js event loop (~50/sec) causing choppy audio
- **Jitter buffer** — 8 frames (160ms) accumulated before first playback
- **Audio gate** — blocks playback during 180 Ringing to prevent hearing the ringback tone from the SIP ringing phase
- **`--buffer 640`** — 80ms speaker buffer for low latency

## Automated Testing

The test harness generates TTS audio via the ElevenLabs API and runs N fully automated transfer cycles:

```bash
# Generate TTS (one-time)
mkdir -p audio
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM" \
  -H "xi-api-key: YOUR_KEY" -H "Content-Type: application/json" \
  -H "Accept: audio/basic" --output audio/transfer-me.ulaw \
  -d '{"text":"Yes, please transfer me to a specialist.","model_id":"eleven_turbo_v2","output_format":"ulaw_8000"}'

# Run 10 tests
npm test

# Run custom count
npm test -- 5
```

Each test run:
1. Opens SIP TCP connection
2. STUN discovers NAT mapping
3. INVITEs Agent A, waits 5s for greeting
4. Queues TTS audio to RTP (5.2s of u-law)
5. Detects ringback tone in RTP stream
6. BYEs Agent A, INVITEs Agent B
7. Verifies Agent B transcript via conversation API
8. Records all audio to `test-results/`

### Results

```
╔══════════════════════════════════════════════════════════╗
║                    TEST RESULTS                         ║
╠══════════════════════════════════════════════════════════╣
║  Total:     10                                          ║
║  PASS:      10/10 (100%)                                ║
║  Transfers: 10/10                                       ║
╚══════════════════════════════════════════════════════════╝
```

~25 seconds per run. Full 10-run suite completes in ~4.5 minutes.

## Key Lessons Learned

| Problem | Root Cause | Solution |
|---------|-----------|----------|
| No audio | SDP had local IP, NAT blocked RTP | STUN discovery before each INVITE |
| Static/noise | RTP header extensions treated as audio | Parse CC, X, P bits in RTP header |
| Choppy audio | sox progress bar flooding event loop | `-q` flag suppresses output |
| Nonstop ring tone | Playing 180 Ringing early media | Audio gate — only play after 200 OK |
| Agent says "transferring" but doesn't | LLM generates text, not tool call | Use `gpt-4o`, not `gpt-4o-mini` |
| Can't detect transfer during call | API `transfer_used` only set after call ends | Ringback tone detection in RTP stream |
| SIP REFER not received | ElevenLabs opens new TCP to Contact URI | Expected behind NAT — tone detection works |

## ElevenLabs API Notes

- Agent tools go in `conversation_config.agent.prompt.tools[]` (not `platform_settings.tools`)
- Transfer tool schema: `params.system_tool_type` + `params.transfers[]` (not nested under `params.transfer_to_number`)
- Phone number credentials: `inbound_trunk_config` for PATCH (not `inbound_trunk`)
- LLM field: `llm: "gpt-4o"` (not `model`)
- TTS model: `eleven_turbo_v2` (not `eleven_flash_v2_5` for English agents on some accounts)
- `termination_uri` required when creating SIP trunk phone numbers
- OpenAPI spec at `/openapi.json` is authoritative when docs diverge from SDK examples

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run setup` | Create ElevenLabs agents + SIP trunk |
| `npm run call` | Interactive demo with two-way audio |
| `npm run call:no-audio` | Headless mode (SIP signaling only) |
| `npm test` | Automated 10-call test suite |
| `npm run teardown` | Delete agents and phone numbers |

## License

MIT
