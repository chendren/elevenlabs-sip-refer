/**
 * Teardown script — removes agents and phone numbers created during setup.
 * Run: npm run teardown
 */
import { CONFIG } from './config.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const API_BASE = CONFIG.elevenlabs.apiBase;
const HEADERS = {
  'xi-api-key': CONFIG.elevenlabs.apiKey,
};
const STATE_FILE = resolve(import.meta.dirname, '../.state.json');

async function deleteResource(path: string, label: string): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'DELETE',
      headers: HEADERS,
    });
    if (response.ok) {
      console.log(`Deleted ${label}`);
    } else {
      console.warn(`Failed to delete ${label}: ${response.status}`);
    }
  } catch (err) {
    console.warn(`Error deleting ${label}:`, err);
  }
}

async function main(): Promise<void> {
  if (!existsSync(STATE_FILE)) {
    console.log('No .state.json found. Nothing to tear down.');
    return;
  }

  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  console.log('=== Tearing down ElevenLabs SIP REFER Demo ===\n');

  // Delete phone numbers first (they reference agents)
  await deleteResource(`/convai/phone-numbers/${state.phoneNumberAId}`, 'Phone A');
  await deleteResource(`/convai/phone-numbers/${state.phoneNumberBId}`, 'Phone B');

  // Delete agents
  await deleteResource(`/convai/agents/${state.agentAId}`, 'Agent A');
  await deleteResource(`/convai/agents/${state.agentBId}`, 'Agent B');

  unlinkSync(STATE_FILE);
  console.log('\nTeardown complete. .state.json removed.');
}

main();
