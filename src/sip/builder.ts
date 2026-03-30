/**
 * SIP message builder — constructs well-formed SIP requests and responses.
 */
import type { SipMessage, SipDialog } from './types.js';
import { createHash, randomUUID } from 'node:crypto';

const CRLF = '\r\n';

/** Generate a unique branch ID (RFC 3261 requires z9hG4bK prefix) */
export function generateBranch(): string {
  return `z9hG4bK-${randomUUID().slice(0, 12)}`;
}

/** Generate a unique tag */
export function generateTag(): string {
  return randomUUID().slice(0, 8);
}

/** Generate a unique Call-ID */
export function generateCallId(host: string): string {
  return `${randomUUID().slice(0, 16)}@${host}`;
}

/** Serialize a SipMessage to a raw string ready for TCP send */
export function serializeSipMessage(msg: SipMessage): string {
  let firstLine: string;

  if (msg.method) {
    // Request
    firstLine = `${msg.method} ${msg.uri} SIP/2.0`;
  } else if (msg.status !== undefined) {
    // Response
    firstLine = `SIP/2.0 ${msg.status} ${msg.reason ?? 'OK'}`;
  } else {
    throw new Error('SIP message must be a request (method) or response (status)');
  }

  const body = msg.body ?? '';
  // Ensure Content-Length is set
  msg.headers['content-length'] = [String(Buffer.byteLength(body, 'utf8'))];

  let output = firstLine + CRLF;

  // Write headers — capitalize first letter of each word for readability
  for (const [name, values] of Object.entries(msg.headers)) {
    const displayName = formatHeaderName(name);
    for (const value of values) {
      output += `${displayName}: ${value}${CRLF}`;
    }
  }

  output += CRLF;
  if (body) output += body;

  return output;
}

/** Build a SIP INVITE request */
export function buildInvite(params: {
  targetUri: string;
  fromUri: string;
  fromTag: string;
  toUri: string;
  callId: string;
  cseq: number;
  contactUri: string;
  viaHost: string;
  viaPort: number;
  branch: string;
  sdp: string;
  extraHeaders?: Record<string, string>;
}): SipMessage {
  const headers: Record<string, string[]> = {
    'via': [`SIP/2.0/TCP ${params.viaHost}:${params.viaPort};rport;branch=${params.branch}`],
    'from': [`<${params.fromUri}>;tag=${params.fromTag}`],
    'to': [`<${params.toUri}>`],
    'call-id': [params.callId],
    'cseq': [`${params.cseq} INVITE`],
    'contact': [`<${params.contactUri};transport=tcp>`],
    'max-forwards': ['70'],
    'user-agent': ['ElevenLabs-SIP-REFER-PoC/1.0'],
    'allow': ['INVITE,ACK,BYE,CANCEL,REFER,NOTIFY,OPTIONS'],
    'supported': ['replaces,timer'],
    'content-type': ['application/sdp'],
  };

  if (params.extraHeaders) {
    for (const [k, v] of Object.entries(params.extraHeaders)) {
      headers[k.toLowerCase()] = [v];
    }
  }

  return {
    method: 'INVITE',
    uri: params.targetUri,
    headers,
    body: params.sdp,
  };
}

/** Build a SIP ACK request */
export function buildAck(params: {
  targetUri: string;
  fromUri: string;
  fromTag: string;
  toUri: string;
  toTag: string;
  callId: string;
  cseq: number;
  viaHost: string;
  viaPort: number;
  branch: string;
  contactUri: string;
  routeSet?: string[];
}): SipMessage {
  const headers: Record<string, string[]> = {
    'via': [`SIP/2.0/TCP ${params.viaHost}:${params.viaPort};rport;branch=${params.branch}`],
    'from': [`<${params.fromUri}>;tag=${params.fromTag}`],
    'to': [`<${params.toUri}>;tag=${params.toTag}`],
    'call-id': [params.callId],
    'cseq': [`${params.cseq} ACK`],
    'contact': [`<${params.contactUri};transport=tcp>`],
    'max-forwards': ['70'],
  };

  if (params.routeSet?.length) {
    headers['route'] = params.routeSet.map(r => `<${r}>`);
  }

  return {
    method: 'ACK',
    uri: params.targetUri,
    headers,
  };
}

/** Build a SIP BYE request */
export function buildBye(dialog: SipDialog, viaHost: string, viaPort: number): SipMessage {
  dialog.localCSeq++;
  return {
    method: 'BYE',
    uri: dialog.remoteTarget,
    headers: {
      'via': [`SIP/2.0/TCP ${viaHost}:${viaPort};rport;branch=${generateBranch()}`],
      'from': [`<${dialog.localUri}>;tag=${dialog.localTag}`],
      'to': [`<${dialog.remoteUri}>;tag=${dialog.remoteTag}`],
      'call-id': [dialog.callId],
      'cseq': [`${dialog.localCSeq} BYE`],
      'max-forwards': ['70'],
    },
  };
}

/** Build a SIP response to an incoming request */
export function buildResponse(
  request: SipMessage,
  statusCode: number,
  reason: string,
  contactUri?: string,
  extraHeaders?: Record<string, string[]>,
): SipMessage {
  const headers: Record<string, string[]> = {
    'via': request.headers['via'] ?? [],
    'from': request.headers['from'] ?? [],
    'to': request.headers['to'] ?? [],
    'call-id': request.headers['call-id'] ?? [],
    'cseq': request.headers['cseq'] ?? [],
  };

  if (contactUri) {
    headers['contact'] = [`<${contactUri};transport=tcp>`];
  }

  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers[k] = v;
    }
  }

  return {
    status: statusCode,
    reason,
    headers,
  };
}

/** Build a SIP NOTIFY for REFER subscription (RFC 3515) */
export function buildReferNotify(params: {
  dialog: SipDialog;
  viaHost: string;
  viaPort: number;
  sipFragStatus: number;
  sipFragReason: string;
  subscriptionState: 'active' | 'terminated';
  cseq: number;
}): SipMessage {
  const body = `SIP/2.0 ${params.sipFragStatus} ${params.sipFragReason}`;

  params.dialog.localCSeq++;
  return {
    method: 'NOTIFY',
    uri: params.dialog.remoteTarget,
    headers: {
      'via': [`SIP/2.0/TCP ${params.viaHost}:${params.viaPort};rport;branch=${generateBranch()}`],
      'from': [`<${params.dialog.localUri}>;tag=${params.dialog.localTag}`],
      'to': [`<${params.dialog.remoteUri}>;tag=${params.dialog.remoteTag}`],
      'call-id': [params.dialog.callId],
      'cseq': [`${params.cseq} NOTIFY`],
      'contact': [`<sip:${params.viaHost}:${params.viaPort};transport=tcp>`],
      'max-forwards': ['70'],
      'event': ['refer'],
      'subscription-state': [params.subscriptionState === 'terminated'
        ? 'terminated;reason=noresource'
        : 'active;expires=60'],
      'content-type': ['message/sipfrag;version=2.0'],
    },
    body,
  };
}

/** Build a digest Authorization header value */
export function buildDigestAuth(params: {
  username: string;
  password: string;
  realm: string;
  nonce: string;
  uri: string;
  method: string;
  opaque?: string;
  qop?: string;
  nc?: string;
  cnonce?: string;
}): string {
  const ha1 = md5(`${params.username}:${params.realm}:${params.password}`);
  const ha2 = md5(`${params.method}:${params.uri}`);

  let response: string;
  let authStr: string;

  if (params.qop === 'auth') {
    const nc = params.nc ?? '00000001';
    const cnonce = params.cnonce ?? randomUUID().slice(0, 8);
    response = md5(`${ha1}:${params.nonce}:${nc}:${cnonce}:auth:${ha2}`);
    authStr = `Digest username="${params.username}", realm="${params.realm}", ` +
      `nonce="${params.nonce}", uri="${params.uri}", ` +
      `qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}", algorithm=MD5`;
  } else {
    response = md5(`${ha1}:${params.nonce}:${ha2}`);
    authStr = `Digest username="${params.username}", realm="${params.realm}", ` +
      `nonce="${params.nonce}", uri="${params.uri}", response="${response}", algorithm=MD5`;
  }

  if (params.opaque) {
    authStr += `, opaque="${params.opaque}"`;
  }

  return authStr;
}

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

/** Convert header names to Title-Case for readability */
function formatHeaderName(name: string): string {
  const specialCases: Record<string, string> = {
    'call-id': 'Call-ID',
    'cseq': 'CSeq',
    'www-authenticate': 'WWW-Authenticate',
    'proxy-authenticate': 'Proxy-Authenticate',
    'content-type': 'Content-Type',
    'content-length': 'Content-Length',
    'max-forwards': 'Max-Forwards',
    'user-agent': 'User-Agent',
    'subscription-state': 'Subscription-State',
    'refer-to': 'Refer-To',
    'referred-by': 'Referred-By',
  };

  if (specialCases[name]) return specialCases[name];
  return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
}
