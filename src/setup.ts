/**
 * ElevenLabs Setup Script
 *
 * Creates two AI agents and configures SIP trunk phone numbers:
 *   Agent A ("Front Desk") — greets caller, then transfers via SIP REFER
 *   Agent B ("Specialist") — receives transferred call, proves concept
 *
 * Run: npm run setup
 */
import { CONFIG } from './config.js';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_BASE = CONFIG.elevenlabs.apiBase;
const HEADERS = {
  'Content-Type': 'application/json',
  'xi-api-key': CONFIG.elevenlabs.apiKey,
};

const STATE_FILE = resolve(import.meta.dirname, '../.state.json');

interface SetupState {
  agentAId: string;
  agentBId: string;
  agentANumber: string;
  agentBNumber: string;
  phoneNumberAId: string;
  phoneNumberBId: string;
  createdAt: string;
}

async function apiCall<T>(path: string, method: string, body?: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  console.log(`[API] ${method} ${path}`);

  const response = await fetch(url, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API ${method} ${path} failed (${response.status}): ${errorBody}`);
  }

  return response.json() as Promise<T>;
}

/** Create Agent A — the front desk greeter that triggers SIP REFER transfer */
async function createAgentA(): Promise<string> {
  console.log('\n--- Creating Agent A (Front Desk) ---');

  // gpt-4o is required — gpt-4o-mini generates text about transferring
  // instead of actually calling the transfer_to_number tool function
  const result = await apiCall<{ agent_id: string }>('/convai/agents/create', 'POST', {
    name: 'SIP REFER Demo - Front Desk',
    conversation_config: {
      agent: {
        first_message: 'Hello! Welcome to the front desk. I can help with general questions, or connect you with a specialist. What can I do for you?',
        language: 'en',
        prompt: {
          llm: 'gpt-4o',
          temperature: 0.5,
          prompt: `You are a friendly front desk receptionist. Chat naturally with callers. Answer general questions. Keep responses to 1-2 sentences.

You have a tool called transfer_to_number. When the caller explicitly asks to be transferred, connected to a specialist, or to speak to someone else, you MUST invoke the transfer_to_number tool. Do not just say you will transfer them — you must actually call the tool function.

Examples of when to call the tool:
- "Transfer me"
- "Connect me to a specialist"
- "I need to speak to someone"
- "Specialist please"
- "Can you transfer me?"

Examples of when NOT to call the tool:
- "How are you?" (just chat)
- "What do you do?" (just answer)
- "Hello" (just greet back)

When you decide to transfer, say a brief message like "Connecting you now!" and then immediately call the transfer_to_number tool.`,
        },
      },
      tts: {
        model_id: 'eleven_turbo_v2',
        voice_id: CONFIG.agents.agentAVoiceId,
      },
      conversation: {
        max_duration_seconds: 300,
      },
    },
  });

  console.log(`Agent A created: ${result.agent_id}`);
  return result.agent_id;
}

/** Add transfer_to_number tool to Agent A via PATCH */
async function configureAgentATransfer(agentAId: string, agentBNumber: string): Promise<void> {
  console.log('\n--- Configuring Agent A transfer tool (SIP REFER) ---');

  await apiCall<unknown>(`/convai/agents/${agentAId}`, 'PATCH', {
    conversation_config: {
      agent: {
        prompt: {
          tools: [
            {
              type: 'system',
              name: 'transfer_to_number',
              description: 'Transfer the caller to the specialist. Call this tool whenever the caller asks to be transferred or connected to someone.',
              params: {
                system_tool_type: 'transfer_to_number',
                transfers: [
                  {
                    condition: 'The caller asks to be transferred, connected, or wants to speak to a specialist or someone else',
                    transfer_type: 'sip_refer',
                    transfer_destination: {
                      type: 'sip_uri',
                      sip_uri: `sip:${agentBNumber}@${CONFIG.elevenlabs.sipHost}`,
                    },
                    custom_sip_headers: [
                      { type: 'static', key: 'X-Transfer-Reason', value: 'specialist-routing' },
                      { type: 'static', key: 'X-Demo', value: 'sip-refer-poc' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    },
  });

  console.log('Transfer tool configured: SIP REFER');
}

/** Create Agent B — the specialist that receives the transfer */
async function createAgentB(): Promise<string> {
  console.log('\n--- Creating Agent B (Specialist) ---');

  const result = await apiCall<{ agent_id: string }>('/convai/agents/create', 'POST', {
    name: 'SIP REFER Demo - Specialist',
    conversation_config: {
      agent: {
        first_message: 'Hi there! I\'m the specialist. I received your transfer from the front desk. The SIP REFER transfer was successful! How can I assist you?',
        language: 'en',
        prompt: {
          llm: 'gpt-4o-mini',
          temperature: 0.7,
          prompt: `You are a friendly specialist who just received a transferred call via SIP REFER.
Your key role in this demo:
1. Acknowledge that you received the transfer successfully
2. Mention that this proves the SIP REFER mechanism is working
3. Be helpful and conversational
4. If asked about the transfer, explain that SIP REFER allows seamless call transfers between AI agents

Keep responses brief (2-3 sentences).`,
        },
      },
      tts: {
        model_id: 'eleven_turbo_v2',
        voice_id: CONFIG.agents.agentBVoiceId,
      },
      conversation: {
        max_duration_seconds: 120,
      },
    },
  });

  console.log(`Agent B created: ${result.agent_id}`);
  return result.agent_id;
}

/** Import a SIP trunk phone number */
async function importPhoneNumber(
  phoneNumber: string,
  label: string,
): Promise<string> {
  console.log(`\n--- Importing phone number ${phoneNumber} for ${label} ---`);

  const result = await apiCall<{ phone_number_id: string }>('/convai/phone-numbers/create', 'POST', {
    provider: 'sip_trunk',
    phone_number: phoneNumber,
    label,
    termination_uri: CONFIG.elevenlabs.sipHost,
  });

  console.log(`Phone number imported: ${result.phone_number_id}`);
  return result.phone_number_id;
}

/** Assign agent and configure credentials on a phone number */
async function configurePhoneNumber(
  phoneNumberId: string,
  agentId: string,
): Promise<void> {
  await apiCall<unknown>(`/convai/phone-numbers/${phoneNumberId}`, 'PATCH', {
    agent_id: agentId,
    inbound_trunk_config: {
      credentials: {
        username: CONFIG.sip.username,
        password: CONFIG.sip.password,
      },
      media_encryption: 'allowed',
    },
  });
}

async function main(): Promise<void> {
  console.log('=== ElevenLabs SIP REFER Demo Setup ===\n');

  // Check for existing state
  if (existsSync(STATE_FILE)) {
    const existing = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as SetupState;
    console.log('Found existing setup state:');
    console.log(`  Agent A: ${existing.agentAId}`);
    console.log(`  Agent B: ${existing.agentBId}`);
    console.log(`  Phone A: ${existing.phoneNumberAId} (${existing.agentANumber})`);
    console.log(`  Phone B: ${existing.phoneNumberBId} (${existing.agentBNumber})`);
    console.log(`  Created: ${existing.createdAt}`);
    console.log('\nTo recreate, delete .state.json first.');
    console.log('To tear down, run: npm run teardown');
    return;
  }

  try {
    // Create agents
    const agentBId = await createAgentB();
    const agentAId = await createAgentA();

    // Configure Agent A's transfer tool pointing to Agent B
    await configureAgentATransfer(agentAId, CONFIG.agents.agentBNumber);

    // Import phone numbers
    const phoneNumberAId = await importPhoneNumber(
      CONFIG.agents.agentANumber,
      'SIP REFER Demo - Front Desk Line',
    );
    const phoneNumberBId = await importPhoneNumber(
      CONFIG.agents.agentBNumber,
      'SIP REFER Demo - Specialist Line',
    );

    // Assign agents and configure auth
    console.log('\n--- Configuring phone numbers ---');
    await configurePhoneNumber(phoneNumberAId, agentAId);
    console.log(`Phone A: agent assigned, credentials set`);
    await configurePhoneNumber(phoneNumberBId, agentBId);
    console.log(`Phone B: agent assigned, credentials set`);

    // Save state
    const state: SetupState = {
      agentAId,
      agentBId,
      agentANumber: CONFIG.agents.agentANumber,
      agentBNumber: CONFIG.agents.agentBNumber,
      phoneNumberAId,
      phoneNumberBId,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    console.log('\n=== Setup Complete ===');
    console.log(`\nAgent A (Front Desk): ${agentAId}`);
    console.log(`  SIP URI: sip:${CONFIG.agents.agentANumber}@${CONFIG.elevenlabs.sipHost}`);
    console.log(`Agent B (Specialist): ${agentBId}`);
    console.log(`  SIP URI: sip:${CONFIG.agents.agentBNumber}@${CONFIG.elevenlabs.sipHost}`);
    console.log(`\nSIP Credentials:`);
    console.log(`  Username: ${CONFIG.sip.username}`);
    console.log(`  Password: ${'*'.repeat(CONFIG.sip.password.length)}`);
    console.log(`\nNext: Run 'npm run call' to start the demo`);
  } catch (err) {
    console.error('\nSetup failed:', err);
    process.exit(1);
  }
}

main();
