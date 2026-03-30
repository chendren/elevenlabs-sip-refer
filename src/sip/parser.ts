/**
 * SIP message parser — handles both requests and responses.
 * Parses SIP messages from raw TCP byte streams using Content-Length framing.
 * Uses only string methods (no regex) per project rules.
 */
import type { SipMessage, DigestChallenge } from './types.js';

const CRLF = '\r\n';
const DOUBLE_CRLF = '\r\n\r\n';

/** Accumulates TCP data and emits complete SIP messages */
export class SipStreamParser {
  private buffer = '';
  private readonly onMessage: (msg: SipMessage) => void;

  constructor(onMessage: (msg: SipMessage) => void) {
    this.onMessage = onMessage;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    this.tryParse();
  }

  private tryParse(): void {
    while (true) {
      // Skip any leading CRLF (keep-alive pings)
      while (this.buffer.startsWith(CRLF)) {
        this.buffer = this.buffer.slice(2);
      }

      const headerEnd = this.buffer.indexOf(DOUBLE_CRLF);
      if (headerEnd === -1) return;

      const headerSection = this.buffer.slice(0, headerEnd);
      const contentLength = extractContentLength(headerSection);

      const totalLength = headerEnd + 4 + contentLength;
      if (this.buffer.length < totalLength) return;

      const rawMessage = this.buffer.slice(0, totalLength);
      this.buffer = this.buffer.slice(totalLength);

      const msg = parseSipMessage(rawMessage);
      if (msg) this.onMessage(msg);
    }
  }
}

/** Extract Content-Length from header section using string methods */
function extractContentLength(headerSection: string): number {
  const lines = headerSection.split(CRLF);
  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    if (lower.startsWith('content-length:') || lower.startsWith('l:')) {
      const colonIdx = line.indexOf(':');
      const value = line.slice(colonIdx + 1).trim();
      const parsed = parseInt(value, 10);
      return isNaN(parsed) ? 0 : parsed;
    }
  }
  return 0;
}

/** Parse a complete SIP message string into structured form */
export function parseSipMessage(raw: string): SipMessage | null {
  const headerBodySplit = raw.indexOf(DOUBLE_CRLF);
  if (headerBodySplit === -1) return null;

  const headerSection = raw.slice(0, headerBodySplit);
  const body = raw.slice(headerBodySplit + 4) || undefined;

  const lines = headerSection.split(CRLF);
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  const msg: SipMessage = { headers: {} };

  // Response: "SIP/2.0 200 OK"
  if (firstLine.startsWith('SIP/2.0')) {
    const afterVersion = firstLine.slice(8); // Skip "SIP/2.0 "
    const spaceIdx = afterVersion.indexOf(' ');
    if (spaceIdx === -1) return null;
    msg.status = parseInt(afterVersion.slice(0, spaceIdx), 10);
    msg.reason = afterVersion.slice(spaceIdx + 1);
  }
  // Request: "INVITE sip:user@host SIP/2.0"
  else if (firstLine.endsWith('SIP/2.0')) {
    const spaceIdx = firstLine.indexOf(' ');
    const lastSpaceIdx = firstLine.lastIndexOf(' ');
    msg.method = firstLine.slice(0, spaceIdx);
    msg.uri = firstLine.slice(spaceIdx + 1, lastSpaceIdx);
  } else {
    return null;
  }

  // Parse headers
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (!msg.headers[name]) msg.headers[name] = [];
    msg.headers[name].push(value);
  }

  if (body && body.length > 0) {
    msg.body = body;
  }

  return msg;
}

/** Extract a single header value (first occurrence) */
export function getHeader(msg: SipMessage, name: string): string | undefined {
  const key = name.toLowerCase();
  const compactMap: Record<string, string> = {
    'i': 'call-id',
    'f': 'from',
    't': 'to',
    'v': 'via',
    'c': 'content-type',
    'l': 'content-length',
    'm': 'contact',
    'e': 'content-encoding',
    'k': 'supported',
  };
  const normalizedKey = compactMap[key] ?? key;
  const values = msg.headers[normalizedKey] ?? msg.headers[key];
  return values?.[0];
}

/** Extract all header values */
export function getHeaders(msg: SipMessage, name: string): string[] {
  return msg.headers[name.toLowerCase()] ?? [];
}

/** Parse the tag from a From/To header value */
export function extractTag(headerValue: string): string | undefined {
  const lower = headerValue.toLowerCase();
  const tagIdx = lower.indexOf(';tag=');
  if (tagIdx === -1) return undefined;

  const start = tagIdx + 5; // length of ";tag="
  let end = headerValue.length;
  // Find end of tag value (next semicolon, space, or >)
  for (let i = start; i < headerValue.length; i++) {
    const ch = headerValue[i];
    if (ch === ';' || ch === ' ' || ch === '>') {
      end = i;
      break;
    }
  }
  return headerValue.slice(start, end);
}

/** Parse the URI from a header value like "<sip:user@host>;tag=xxx" */
export function extractUri(headerValue: string): string {
  const ltIdx = headerValue.indexOf('<');
  const gtIdx = headerValue.indexOf('>');
  if (ltIdx !== -1 && gtIdx !== -1 && gtIdx > ltIdx) {
    return headerValue.slice(ltIdx + 1, gtIdx);
  }
  // No angle brackets — take everything before parameters
  const semiIdx = headerValue.indexOf(';');
  return semiIdx !== -1 ? headerValue.slice(0, semiIdx).trim() : headerValue.trim();
}

/** Parse a Refer-To header */
export function extractReferTo(headerValue: string): string {
  return extractUri(headerValue);
}

/** Parse WWW-Authenticate or Proxy-Authenticate header into a DigestChallenge */
export function parseDigestChallenge(headerValue: string): DigestChallenge | null {
  if (!headerValue.startsWith('Digest')) return null;

  const params = headerValue.slice(7); // Remove "Digest "
  const challenge: Partial<DigestChallenge> = {};

  const parts = splitDigestParams(params);
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim().toLowerCase();
    let value = part.slice(eqIdx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case 'realm': challenge.realm = value; break;
      case 'nonce': challenge.nonce = value; break;
      case 'opaque': challenge.opaque = value; break;
      case 'qop': challenge.qop = value; break;
      case 'algorithm': challenge.algorithm = value; break;
    }
  }

  if (!challenge.realm || !challenge.nonce) return null;
  return challenge as DigestChallenge;
}

/** Split digest params respecting quoted values */
function splitDigestParams(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of input) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
