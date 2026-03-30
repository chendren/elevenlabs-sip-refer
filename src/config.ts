/**
 * Configuration loader from environment variables.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(import.meta.dirname, '../.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    console.error(`Copy .env.example to .env and fill in your values.`);
    process.exit(1);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export const CONFIG = {
  elevenlabs: {
    apiKey: required('ELEVENLABS_API_KEY'),
    sipHost: optional('ELEVENLABS_SIP_HOST', 'sip.rtc.elevenlabs.io'),
    sipPort: parseInt(optional('ELEVENLABS_SIP_PORT', '5060'), 10),
    apiBase: 'https://api.elevenlabs.io/v1',
  },
  sip: {
    username: optional('SIP_USERNAME', 'sip-client'),
    password: optional('SIP_PASSWORD', 'change-this-password'),
  },
  agents: {
    agentANumber: optional('AGENT_A_NUMBER', '+10000000001'),
    agentBNumber: optional('AGENT_B_NUMBER', '+10000000002'),
    agentAVoiceId: optional('AGENT_A_VOICE_ID', '21m00Tcm4TlvDq8ikWAM'),
    agentBVoiceId: optional('AGENT_B_VOICE_ID', 'AZnzlk1XvdvUeBnXmlld'),
  },
  local: {
    ip: optional('LOCAL_IP', '0.0.0.0'),
    sipPort: parseInt(optional('LOCAL_SIP_PORT', '5060'), 10),
    rtpPort: parseInt(optional('LOCAL_RTP_PORT', '10000'), 10),
  },
} as const;
