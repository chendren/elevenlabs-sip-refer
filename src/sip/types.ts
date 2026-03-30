/** SIP message types for our minimal SIP stack */

export interface SipUri {
  scheme: 'sip' | 'sips';
  user?: string;
  host: string;
  port?: number;
  params: Record<string, string>;
}

export interface SipHeader {
  raw: string;
  params?: Record<string, string>;
}

export interface SipMessage {
  // Request fields
  method?: string;
  uri?: string;
  // Response fields
  status?: number;
  reason?: string;
  // Common
  headers: Record<string, string[]>;
  body?: string;
}

export interface SipDialog {
  callId: string;
  localTag: string;
  remoteTag: string;
  localUri: string;
  remoteUri: string;
  remoteTarget: string; // Contact URI from remote
  localCSeq: number;
  routeSet: string[];
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  qop?: string;
  algorithm?: string;
}

export interface DigestCredentials {
  username: string;
  password: string;
}

export type SipTransport = 'tcp' | 'tls';

export interface SipClientConfig {
  localIp: string;
  localPort: number;
  /** Public IP for SDP/Contact (NAT traversal). Falls back to localIp. */
  publicIp?: string;
  remoteHost: string;
  remotePort: number;
  transport: SipTransport;
  credentials: DigestCredentials;
}

export interface CallState {
  id: string;
  dialog?: SipDialog;
  state: 'idle' | 'inviting' | 'ringing' | 'active' | 'terminating' | 'terminated';
  localRtpPort: number;
  remoteRtpHost?: string;
  remoteRtpPort?: number;
}
