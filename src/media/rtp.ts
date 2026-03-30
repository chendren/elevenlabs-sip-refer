/**
 * RTP (Real-time Transport Protocol) handler.
 * Sends and receives RTP packets over UDP for voice audio.
 *
 * RTP Header (12 bytes):
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |V=2|P|X|  CC   |M|     PT      |       sequence number         |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                           timestamp                           |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |           synchronization source (SSRC) identifier            |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 */
import * as dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { generateUlawSilence } from './g711.js';

const RTP_HEADER_SIZE = 12;
const PCMU_PAYLOAD_TYPE = 0;
const SAMPLES_PER_FRAME = 160; // 20ms at 8000 Hz
const FRAME_DURATION_MS = 20;

export interface RtpPacket {
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
}

export class RtpSession extends EventEmitter {
  private socket: dgram.Socket;
  private localPort: number;
  private remoteHost?: string;
  private remotePort?: number;
  private ssrc: number;
  private sequenceNumber = 0;
  private timestamp = 0;
  private sendTimer?: ReturnType<typeof setInterval>;
  private active = false;
  private audioQueue: Buffer[] = [];
  private firstPacketLogged = false;

  constructor(localPort: number) {
    super();
    this.localPort = localPort;
    this.ssrc = Math.floor(Math.random() * 0xFFFFFFFF);
    this.socket = dgram.createSocket('udp4');
  }

  /** Expose the underlying UDP socket (for STUN NAT discovery) */
  getSocket(): dgram.Socket {
    return this.socket;
  }

  /** Start listening for RTP packets */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.on('error', (err) => {
        console.error(`[RTP] Socket error:`, err.message);
        reject(err);
      });

      this.socket.on('message', (msg, rinfo) => {
        this.handlePacket(msg, rinfo);
      });

      this.socket.bind(this.localPort, '0.0.0.0', () => {
        console.log(`[RTP] Listening on port ${this.localPort}`);
        this.active = true;
        resolve();
      });
    });
  }

  /** Set the remote RTP endpoint and start sending */
  setRemote(host: string, port: number): void {
    this.remoteHost = host;
    this.remotePort = port;
    console.log(`[RTP] Remote endpoint: ${host}:${port}`);
    this.startSending();
  }

  /** Queue audio data (u-law encoded) for sending */
  queueAudio(ulawData: Buffer): void {
    this.audioQueue.push(ulawData);
  }

  /** Stop the RTP session */
  stop(): void {
    if (!this.active) return; // guard against double-close
    this.active = false;
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = undefined;
    }
    try { this.socket.close(); } catch { /* already closed */ }
    this.audioQueue = [];
  }

  /** Start the 20ms send timer */
  private startSending(): void {
    if (this.sendTimer) return;

    this.sendTimer = setInterval(() => {
      if (!this.active || !this.remoteHost || !this.remotePort) return;

      let payload: Buffer;
      if (this.audioQueue.length > 0) {
        // Dequeue and send real audio
        const chunk = this.audioQueue.shift()!;
        // Ensure exactly SAMPLES_PER_FRAME bytes
        if (chunk.length >= SAMPLES_PER_FRAME) {
          payload = chunk.subarray(0, SAMPLES_PER_FRAME);
          if (chunk.length > SAMPLES_PER_FRAME) {
            this.audioQueue.unshift(chunk.subarray(SAMPLES_PER_FRAME));
          }
        } else {
          // Pad with silence
          payload = Buffer.concat([chunk, generateUlawSilence(SAMPLES_PER_FRAME - chunk.length)]);
        }
      } else {
        // Send silence to keep NAT pinhole open
        payload = generateUlawSilence(SAMPLES_PER_FRAME);
      }

      this.sendPacket(payload);
    }, FRAME_DURATION_MS);
  }

  /** Send a single RTP packet */
  private sendPacket(payload: Buffer): void {
    if (!this.remoteHost || !this.remotePort) return;

    const header = Buffer.alloc(RTP_HEADER_SIZE);
    // V=2, P=0, X=0, CC=0
    header[0] = 0x80;
    // M=0, PT=0 (PCMU)
    header[1] = PCMU_PAYLOAD_TYPE;
    // Sequence number
    header.writeUInt16BE(this.sequenceNumber & 0xFFFF, 2);
    // Timestamp
    header.writeUInt32BE(this.timestamp & 0xFFFFFFFF, 4);
    // SSRC
    header.writeUInt32BE(this.ssrc, 8);

    const packet = Buffer.concat([header, payload]);
    this.socket.send(packet, this.remotePort, this.remoteHost);

    this.sequenceNumber++;
    this.timestamp += SAMPLES_PER_FRAME;
  }

  /** Parse an incoming RTP packet, handling variable-length headers */
  private handlePacket(data: Buffer, rinfo: dgram.RemoteInfo): void {
    if (data.length < RTP_HEADER_SIZE) return;

    const firstByte = data[0];
    const cc = firstByte & 0x0F;           // CSRC count
    const hasExtension = (firstByte & 0x10) !== 0; // X bit
    const hasPadding = (firstByte & 0x20) !== 0;   // P bit

    // Calculate actual header size:
    // 12 fixed + 4*CC for CSRC entries
    let headerSize = RTP_HEADER_SIZE + (cc * 4);

    // If extension bit set, skip extension header
    if (hasExtension && data.length >= headerSize + 4) {
      // Extension header: 2 bytes profile, 2 bytes length (in 32-bit words)
      const extLength = data.readUInt16BE(headerSize + 2);
      headerSize += 4 + (extLength * 4);
    }

    if (data.length <= headerSize) return;

    let payloadEnd = data.length;
    // If padding bit set, last byte tells us how many padding bytes
    if (hasPadding) {
      const paddingLen = data[data.length - 1];
      payloadEnd -= paddingLen;
    }

    if (payloadEnd <= headerSize) return;

    const payloadType = data[1] & 0x7F;
    const payload = data.subarray(headerSize, payloadEnd);

    // One-time debug: log first packet details
    if (!this.firstPacketLogged && payload.length > 0) {
      this.firstPacketLogged = true;
      console.log(`[RTP] First packet: PT=${payloadType} size=${data.length} hdr=${headerSize} payload=${payload.length} CC=${cc} X=${hasExtension} P=${hasPadding}`);
    }

    // Only process PCMU audio
    if (payloadType === PCMU_PAYLOAD_TYPE && payload.length > 0) {
      this.emit('audio', payload);
    }
  }
}
