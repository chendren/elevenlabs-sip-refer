/**
 * SDP (Session Description Protocol) builder and parser.
 * Generates SDP offers for SIP INVITE and parses SDP answers.
 */

/** Build an SDP offer for a voice call */
export function buildSdpOffer(localIp: string, rtpPort: number): string {
  const sessionId = Date.now();
  return [
    'v=0',
    `o=- ${sessionId} ${sessionId} IN IP4 ${localIp}`,
    's=ElevenLabs SIP REFER PoC',
    `c=IN IP4 ${localIp}`,
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP 0 101`,
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-16',
    'a=ptime:20',
    'a=sendrecv',
    '',
  ].join('\r\n');
}

/** Parse an SDP answer to extract remote RTP host and port */
export function parseSdpAnswer(sdp: string): { host: string; port: number } | null {
  const lines = sdp.split('\r\n');
  let host: string | null = null;
  let port: number | null = null;

  for (const line of lines) {
    // Connection line: c=IN IP4 1.2.3.4
    if (line.startsWith('c=IN IP4 ')) {
      host = line.slice(9).trim();
    }
    // Media line: m=audio 12345 RTP/AVP 0
    if (line.startsWith('m=audio ')) {
      const parts = line.split(' ');
      if (parts.length >= 2) {
        port = parseInt(parts[1], 10);
      }
    }
  }

  if (host && port && !isNaN(port)) {
    return { host, port };
  }
  return null;
}
