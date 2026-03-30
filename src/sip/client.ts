/**
 * High-level SIP client for ElevenLabs SIP trunk.
 * Handles: INVITE with digest auth, ACK, BYE, incoming REFER, NOTIFY.
 */
import { EventEmitter } from 'node:events';
import type { SipMessage, SipDialog, SipClientConfig, CallState, DigestChallenge } from './types.js';
import { SipTransportLayer } from './transport.js';
import {
  buildInvite, buildAck, buildBye, buildResponse,
  buildReferNotify, buildDigestAuth,
  generateBranch, generateTag, generateCallId,
} from './builder.js';
import {
  SipStreamParser,
  getHeader, extractTag, extractUri, extractReferTo,
  parseDigestChallenge,
} from './parser.js';
import { buildSdpOffer, parseSdpAnswer } from '../media/sdp.js';

export interface SipClientEvents {
  callEstablished: (callId: string, remoteRtpHost: string, remoteRtpPort: number) => void;
  callTerminated: (callId: string) => void;
  referReceived: (callId: string, referToUri: string, customHeaders: Record<string, string>) => void;
  error: (err: Error) => void;
}

export class SipClient extends EventEmitter {
  private transport: SipTransportLayer;
  private config: SipClientConfig;
  private calls = new Map<string, CallState>();
  private pendingInvites = new Map<string, {
    resolve: (callId: string) => void;
    reject: (err: Error) => void;
    originalInvite: SipMessage;
    targetUri: string;
    toUri: string;
    sdp: string;
  }>();

  /** IP advertised in SDP/Contact (public IP if behind NAT, else local) */
  private get advertisedIp(): string {
    return this.config.publicIp ?? this.config.localIp;
  }

  constructor(config: SipClientConfig) {
    super();
    this.config = config;
    this.transport = new SipTransportLayer(
      config.remoteHost,
      config.remotePort,
      config.transport,
    );
    this.transport.on('message', (msg) => this.handleMessage(msg));
  }

  /** Connect to ElevenLabs SIP endpoint */
  async connect(): Promise<void> {
    await this.transport.connect();
  }

  /** Originate a call to a SIP URI.
   *  sdpOverride allows specifying a different IP:port for the SDP (from STUN). */
  async invite(targetNumber: string, localRtpPort: number, sdpOverride?: { ip: string; port: number }): Promise<string> {
    const targetUri = `sip:${targetNumber}@${this.config.remoteHost};transport=tcp`;
    const fromUri = `sip:${this.config.credentials.username}@${this.advertisedIp}`;
    const toUri = targetUri;
    const contactUri = `sip:${this.config.credentials.username}@${this.advertisedIp}:${this.config.localPort}`;
    const callId = generateCallId(this.advertisedIp);
    const fromTag = generateTag();
    const branch = generateBranch();

    const sdpIp = sdpOverride?.ip ?? this.advertisedIp;
    const sdpPort = sdpOverride?.port ?? localRtpPort;
    const sdp = buildSdpOffer(sdpIp, sdpPort);

    const callState: CallState = {
      id: callId,
      state: 'inviting',
      localRtpPort,
    };
    this.calls.set(callId, callState);

    const invite = buildInvite({
      targetUri,
      fromUri,
      fromTag,
      toUri,
      callId,
      cseq: 1,
      contactUri,
      viaHost: this.advertisedIp,
      viaPort: this.config.localPort,
      branch,
      sdp,
    });

    return new Promise((resolve, reject) => {
      this.pendingInvites.set(callId, {
        resolve,
        reject,
        originalInvite: invite,
        targetUri,
        toUri,
        sdp,
      });
      this.transport.send(invite);
    });
  }

  /** Handle raw SIP data from an incoming TCP connection (for REFER) */
  handleRawIncoming(data: string): void {
    const parser = new SipStreamParser((msg: SipMessage) => this.handleMessage(msg));
    parser.feed(data);
  }

  /** Hang up an active call */
  hangup(callId: string): void {
    const call = this.calls.get(callId);
    if (!call?.dialog) {
      console.log(`[SIP Client] No dialog for call ${callId}, cannot BYE`);
      return;
    }

    call.state = 'terminating';
    const bye = buildBye(
      call.dialog,
      this.advertisedIp,
      this.config.localPort,
    );
    this.transport.send(bye);
  }

  /** Close the SIP connection */
  close(): void {
    // BYE all active calls
    for (const [callId, call] of this.calls) {
      if (call.state === 'active' && call.dialog) {
        this.hangup(callId);
      }
    }
    this.transport.close();
  }

  /** Get current call state */
  getCallState(callId: string): CallState | undefined {
    return this.calls.get(callId);
  }

  // ── Message handling ──────────────────────────────────────────

  private handleMessage(msg: SipMessage): void {
    if (msg.status !== undefined) {
      this.handleResponse(msg);
    } else if (msg.method) {
      this.handleRequest(msg);
    }
  }

  private handleResponse(msg: SipMessage): void {
    const callId = getHeader(msg, 'call-id');
    if (!callId) return;

    const cseqHeader = getHeader(msg, 'cseq');
    if (!cseqHeader) return;

    const method = cseqHeader.split(' ').pop()?.toUpperCase();
    const status = msg.status!;

    console.log(`[SIP RX] ${status} ${msg.reason} (${method}) [Call-ID: ${callId.slice(0, 8)}...]`);

    if (method === 'INVITE') {
      this.handleInviteResponse(msg, callId, status);
    } else if (method === 'BYE') {
      if (status >= 200) {
        const call = this.calls.get(callId);
        if (call) {
          call.state = 'terminated';
          console.log(`[SIP Client] Call ${callId.slice(0, 8)} terminated (BYE confirmed)`);
          this.emit('callTerminated', callId);
        }
      }
    } else if (method === 'NOTIFY') {
      // 200 OK to our NOTIFY — acknowledged
    }
  }

  private handleInviteResponse(msg: SipMessage, callId: string, status: number): void {
    const pending = this.pendingInvites.get(callId);
    if (!pending) return;

    // Provisional (100 Trying, 180 Ringing)
    if (status >= 100 && status < 200) {
      const call = this.calls.get(callId);
      if (call && status === 180) {
        call.state = 'ringing';
        console.log(`[SIP Client] Call ${callId.slice(0, 8)} ringing...`);
      }
      return;
    }

    // Auth challenge (401 or 407)
    if (status === 401 || status === 407) {
      this.handleAuthChallenge(msg, callId, pending);
      return;
    }

    // Success (200 OK)
    if (status >= 200 && status < 300) {
      this.handleInviteSuccess(msg, callId, pending);
      return;
    }

    // Failure
    if (status >= 300) {
      const call = this.calls.get(callId);
      if (call) call.state = 'terminated';
      this.pendingInvites.delete(callId);
      pending.reject(new Error(`INVITE failed: ${status} ${msg.reason}`));
    }
  }

  private handleAuthChallenge(
    msg: SipMessage,
    callId: string,
    pending: {
      resolve: (callId: string) => void;
      reject: (err: Error) => void;
      originalInvite: SipMessage;
      targetUri: string;
      toUri: string;
      sdp: string;
    },
  ): void {
    const authHeader = getHeader(msg, 'www-authenticate') ?? getHeader(msg, 'proxy-authenticate');
    if (!authHeader) {
      pending.reject(new Error('Auth challenge without WWW-Authenticate header'));
      return;
    }

    const challenge = parseDigestChallenge(authHeader);
    if (!challenge) {
      pending.reject(new Error('Failed to parse digest challenge'));
      return;
    }

    console.log(`[SIP Client] Received auth challenge, realm: ${challenge.realm}`);

    // Build authenticated INVITE
    const fromHeader = getHeader(pending.originalInvite, 'from')!;
    const fromTag = extractTag(fromHeader) ?? generateTag();
    const contactUri = `sip:${this.config.credentials.username}@${this.advertisedIp}:${this.config.localPort}`;
    const newBranch = generateBranch();

    const authValue = buildDigestAuth({
      username: this.config.credentials.username,
      password: this.config.credentials.password,
      realm: challenge.realm,
      nonce: challenge.nonce,
      uri: pending.targetUri,
      method: 'INVITE',
      opaque: challenge.opaque,
      qop: challenge.qop,
    });

    const isProxy = getHeader(msg, 'proxy-authenticate') !== undefined;
    const authHeaderName = isProxy ? 'proxy-authorization' : 'authorization';

    const authInvite = buildInvite({
      targetUri: pending.targetUri,
      fromUri: `sip:${this.config.credentials.username}@${this.advertisedIp}`,
      fromTag,
      toUri: pending.toUri,
      callId,
      cseq: 2,
      contactUri,
      viaHost: this.advertisedIp,
      viaPort: this.config.localPort,
      branch: newBranch,
      sdp: pending.sdp,
      extraHeaders: { [authHeaderName]: authValue },
    });

    pending.originalInvite = authInvite;
    this.transport.send(authInvite);
  }

  private handleInviteSuccess(
    msg: SipMessage,
    callId: string,
    pending: {
      resolve: (callId: string) => void;
      reject: (err: Error) => void;
      originalInvite: SipMessage;
      targetUri: string;
      toUri: string;
      sdp: string;
    },
  ): void {
    const call = this.calls.get(callId);
    if (!call) return;

    // Parse remote SDP for RTP info
    if (msg.body) {
      const rtpInfo = parseSdpAnswer(msg.body);
      if (rtpInfo) {
        call.remoteRtpHost = rtpInfo.host;
        call.remoteRtpPort = rtpInfo.port;
      }
    }

    // Build dialog state
    const fromHeader = getHeader(pending.originalInvite, 'from')!;
    const toHeader = getHeader(msg, 'to')!;
    const contactHeader = getHeader(msg, 'contact');
    const remoteTarget = contactHeader ? extractUri(contactHeader) : pending.targetUri;

    call.dialog = {
      callId,
      localTag: extractTag(fromHeader) ?? '',
      remoteTag: extractTag(toHeader) ?? '',
      localUri: extractUri(fromHeader),
      remoteUri: extractUri(toHeader),
      remoteTarget,
      localCSeq: 2,
      routeSet: [],
    };
    call.state = 'active';

    // Send ACK
    const ack = buildAck({
      targetUri: remoteTarget,
      fromUri: call.dialog.localUri,
      fromTag: call.dialog.localTag,
      toUri: call.dialog.remoteUri,
      toTag: call.dialog.remoteTag,
      callId,
      cseq: 1, // ACK CSeq matches the INVITE CSeq
      viaHost: this.advertisedIp,
      viaPort: this.config.localPort,
      branch: generateBranch(),
      contactUri: `sip:${this.config.credentials.username}@${this.advertisedIp}:${this.config.localPort}`,
    });
    this.transport.send(ack);

    console.log(`[SIP Client] Call ${callId.slice(0, 8)} established!`);
    if (call.remoteRtpHost && call.remoteRtpPort) {
      console.log(`[SIP Client] Remote RTP: ${call.remoteRtpHost}:${call.remoteRtpPort}`);
    }

    this.pendingInvites.delete(callId);
    pending.resolve(callId);

    this.emit('callEstablished', callId, call.remoteRtpHost ?? '', call.remoteRtpPort ?? 0);
  }

  // ── Incoming request handling ─────────────────────────────────

  private handleRequest(msg: SipMessage): void {
    const method = msg.method!;
    console.log(`[SIP RX] ${method} request`);

    switch (method) {
      case 'REFER':
        this.handleRefer(msg);
        break;
      case 'BYE':
        this.handleIncomingBye(msg);
        break;
      case 'OPTIONS':
        this.handleOptions(msg);
        break;
      case 'NOTIFY':
        this.handleIncomingNotify(msg);
        break;
      default:
        // Send 405 Method Not Allowed
        const response = buildResponse(msg, 405, 'Method Not Allowed');
        this.transport.send(response);
    }
  }

  /** Handle incoming SIP REFER — the core of our transfer logic */
  private handleRefer(msg: SipMessage): void {
    const callId = getHeader(msg, 'call-id');
    const referToHeader = getHeader(msg, 'refer-to');

    if (!callId || !referToHeader) {
      const response = buildResponse(msg, 400, 'Bad Request');
      this.transport.send(response);
      return;
    }

    const referToUri = extractReferTo(referToHeader);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[SIP REFER] Transfer requested!`);
    console.log(`[SIP REFER] Refer-To: ${referToUri}`);
    console.log(`${'='.repeat(60)}\n`);

    // Extract custom headers (X-Conversation-ID, X-Caller-ID, etc.)
    const customHeaders: Record<string, string> = {};
    for (const [name, values] of Object.entries(msg.headers)) {
      if (name.startsWith('x-')) {
        customHeaders[name] = values[0];
      }
    }
    if (Object.keys(customHeaders).length > 0) {
      console.log(`[SIP REFER] Custom headers:`, customHeaders);
    }

    // Send 202 Accepted
    const contactUri = `sip:${this.config.credentials.username}@${this.advertisedIp}:${this.config.localPort}`;
    const response = buildResponse(msg, 202, 'Accepted', contactUri);
    this.transport.send(response);

    // Find the call this REFER belongs to
    const call = this.calls.get(callId);
    if (!call?.dialog) {
      console.log(`[SIP REFER] No dialog found for call ${callId}`);
      return;
    }

    // Send initial NOTIFY (100 Trying)
    const notify100 = buildReferNotify({
      dialog: call.dialog,
      viaHost: this.advertisedIp,
      viaPort: this.config.localPort,
      sipFragStatus: 100,
      sipFragReason: 'Trying',
      subscriptionState: 'active',
      cseq: call.dialog.localCSeq + 1,
    });
    this.transport.send(notify100);

    // Emit event so the orchestrator can handle the transfer
    this.emit('referReceived', callId, referToUri, customHeaders);
  }

  /** Send final NOTIFY for REFER subscription */
  sendReferNotifyFinal(callId: string, success: boolean): void {
    const call = this.calls.get(callId);
    if (!call?.dialog) return;

    const notify = buildReferNotify({
      dialog: call.dialog,
      viaHost: this.advertisedIp,
      viaPort: this.config.localPort,
      sipFragStatus: success ? 200 : 503,
      sipFragReason: success ? 'OK' : 'Service Unavailable',
      subscriptionState: 'terminated',
      cseq: call.dialog.localCSeq + 1,
    });
    this.transport.send(notify);
  }

  private handleIncomingBye(msg: SipMessage): void {
    const callId = getHeader(msg, 'call-id');
    if (!callId) return;

    // Send 200 OK
    const response = buildResponse(msg, 200, 'OK');
    this.transport.send(response);

    const call = this.calls.get(callId);
    if (call) {
      call.state = 'terminated';
      console.log(`[SIP Client] Call ${callId.slice(0, 8)} terminated (remote BYE)`);
      this.emit('callTerminated', callId);
    }
  }

  private handleOptions(msg: SipMessage): void {
    const response = buildResponse(msg, 200, 'OK', undefined, {
      'allow': ['INVITE,ACK,BYE,CANCEL,REFER,NOTIFY,OPTIONS'],
      'accept': ['application/sdp'],
    });
    this.transport.send(response);
  }

  private handleIncomingNotify(msg: SipMessage): void {
    // Respond 200 OK to any NOTIFY
    const response = buildResponse(msg, 200, 'OK');
    this.transport.send(response);
  }
}
