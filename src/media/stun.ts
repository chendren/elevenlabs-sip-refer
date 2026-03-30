/**
 * Minimal STUN client for NAT traversal.
 * Sends a Binding Request to discover our public IP:port mapping
 * for a given UDP socket. This mapping is then used in the SDP
 * so ElevenLabs can send RTP audio back to us.
 *
 * Implements RFC 5389 (STUN) — Binding Request/Response only.
 */
import * as dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

const STUN_MAGIC_COOKIE = 0x2112A442;
const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;
const STUN_XOR_MAPPED_ADDRESS = 0x0020;
const STUN_MAPPED_ADDRESS = 0x0001;

export interface StunMapping {
  publicIp: string;
  publicPort: number;
}

/** Build a STUN Binding Request (20 bytes) */
function buildBindingRequest(): { packet: Buffer; transactionId: Buffer } {
  const transactionId = randomBytes(12);
  const packet = Buffer.alloc(20);

  // Message Type: Binding Request (0x0001)
  packet.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  // Message Length: 0 (no attributes)
  packet.writeUInt16BE(0, 2);
  // Magic Cookie
  packet.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  // Transaction ID (12 bytes)
  transactionId.copy(packet, 8);

  return { packet, transactionId };
}

/** Parse XOR-MAPPED-ADDRESS from a STUN response */
function parseXorMappedAddress(data: Buffer, offset: number, length: number): StunMapping | null {
  if (length < 8) return null;

  // Skip reserved byte, read family
  const family = data[offset + 1];
  if (family !== 0x01) return null; // Only IPv4

  // XOR'd port: port XOR (magic cookie >> 16)
  const xorPort = data.readUInt16BE(offset + 2);
  const port = xorPort ^ (STUN_MAGIC_COOKIE >>> 16);

  // XOR'd IP: IP XOR magic cookie
  const xorIp = data.readUInt32BE(offset + 4);
  const ip = xorIp ^ STUN_MAGIC_COOKIE;

  const publicIp = [
    (ip >>> 24) & 0xFF,
    (ip >>> 16) & 0xFF,
    (ip >>> 8) & 0xFF,
    ip & 0xFF,
  ].join('.');

  return { publicIp, publicPort: port };
}

/** Parse MAPPED-ADDRESS (non-XOR'd) from a STUN response */
function parseMappedAddress(data: Buffer, offset: number, length: number): StunMapping | null {
  if (length < 8) return null;

  const family = data[offset + 1];
  if (family !== 0x01) return null;

  const port = data.readUInt16BE(offset + 2);
  const ip = [
    data[offset + 4],
    data[offset + 5],
    data[offset + 6],
    data[offset + 7],
  ].join('.');

  return { publicIp: ip, publicPort: port };
}

/** Parse a STUN Binding Response */
function parseBindingResponse(data: Buffer, expectedTxId: Buffer): StunMapping | null {
  if (data.length < 20) return null;

  const msgType = data.readUInt16BE(0);
  if (msgType !== STUN_BINDING_RESPONSE) return null;

  const magic = data.readUInt32BE(4);
  if (magic !== STUN_MAGIC_COOKIE) return null;

  // Verify transaction ID
  const txId = data.subarray(8, 20);
  if (!txId.equals(expectedTxId)) return null;

  const msgLength = data.readUInt16BE(2);

  // Parse attributes
  let offset = 20;
  const end = 20 + msgLength;
  let result: StunMapping | null = null;

  while (offset + 4 <= end) {
    const attrType = data.readUInt16BE(offset);
    const attrLength = data.readUInt16BE(offset + 2);
    const attrOffset = offset + 4;

    if (attrType === STUN_XOR_MAPPED_ADDRESS) {
      result = parseXorMappedAddress(data, attrOffset, attrLength);
      if (result) return result; // Prefer XOR-MAPPED-ADDRESS
    } else if (attrType === STUN_MAPPED_ADDRESS && !result) {
      result = parseMappedAddress(data, attrOffset, attrLength);
    }

    // Attributes are padded to 4-byte boundaries
    offset = attrOffset + attrLength;
    if (offset % 4 !== 0) offset += 4 - (offset % 4);
  }

  return result;
}

/**
 * Discover the NAT-mapped public address for a given UDP socket.
 * Sends STUN Binding Request and returns the mapped IP:port.
 *
 * @param socket - The UDP socket to discover mapping for (must be bound)
 * @param stunServer - STUN server hostname (default: Google's)
 * @param stunPort - STUN server port (default: 19302)
 * @param timeoutMs - Timeout in ms (default: 3000)
 */
export async function discoverNatMapping(
  socket: dgram.Socket,
  stunServer = 'stun.l.google.com',
  stunPort = 19302,
  timeoutMs = 3000,
): Promise<StunMapping | null> {
  const { packet, transactionId } = buildBindingRequest();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.removeListener('message', handler);
      resolve(null);
    }, timeoutMs);

    function handler(msg: Buffer, rinfo: dgram.RemoteInfo) {
      const result = parseBindingResponse(msg, transactionId);
      if (result) {
        clearTimeout(timeout);
        socket.removeListener('message', handler);
        resolve(result);
      }
    }

    socket.on('message', handler);

    // Send STUN request (retry twice for reliability)
    socket.send(packet, stunPort, stunServer);
    setTimeout(() => socket.send(packet, stunPort, stunServer), 500);
  });
}
