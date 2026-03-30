/**
 * SIP TCP transport layer.
 * Manages TCP connections and routes incoming SIP messages.
 */
import * as net from 'node:net';
import * as tls from 'node:tls';
import { EventEmitter } from 'node:events';
import type { SipMessage, SipTransport } from './types.js';
import { SipStreamParser } from './parser.js';
import { serializeSipMessage } from './builder.js';

export interface TransportEvents {
  message: (msg: SipMessage) => void;
  connected: () => void;
  error: (err: Error) => void;
  closed: () => void;
}

export class SipTransportLayer extends EventEmitter {
  private socket: net.Socket | null = null;
  private parser: SipStreamParser;
  private readonly remoteHost: string;
  private readonly remotePort: number;
  private readonly transportType: SipTransport;
  private keepAliveTimer?: ReturnType<typeof setInterval>;

  constructor(remoteHost: string, remotePort: number, transport: SipTransport = 'tcp') {
    super();
    this.remoteHost = remoteHost;
    this.remotePort = remotePort;
    this.transportType = transport;
    this.parser = new SipStreamParser((msg) => this.emit('message', msg));
  }

  /** Connect to the remote SIP endpoint */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        // Clear the initial connection timeout — SIP dialogs can be idle
        // (audio flows via RTP/UDP, not over this TCP connection)
        this.socket?.setTimeout(0);
        // SIP keep-alive: send CRLF every 15s to keep TCP connection alive
        this.keepAliveTimer = setInterval(() => {
          if (this.socket && !this.socket.destroyed) {
            this.socket.write('\r\n\r\n');
          }
        }, 15000);
        console.log(`[SIP Transport] Connected to ${this.remoteHost}:${this.remotePort} via ${this.transportType.toUpperCase()}`);
        this.emit('connected');
        resolve();
      };

      if (this.transportType === 'tls') {
        this.socket = tls.connect({
          host: this.remoteHost,
          port: this.remotePort,
          rejectUnauthorized: true,
        }, onConnect);
      } else {
        this.socket = net.createConnection({
          host: this.remoteHost,
          port: this.remotePort,
        }, onConnect);
      }

      this.socket.setEncoding('utf8');
      this.socket.setKeepAlive(true, 30000);

      this.socket.on('data', (data: string) => {
        this.parser.feed(data);
      });

      this.socket.on('error', (err) => {
        console.error(`[SIP Transport] Socket error:`, err.message);
        this.emit('error', err);
        if (!this.socket) reject(err);
      });

      this.socket.on('close', () => {
        console.log('[SIP Transport] Connection closed');
        this.emit('closed');
      });

      // Timeout for initial connection
      this.socket.setTimeout(10000, () => {
        const err = new Error('Connection timeout');
        this.socket?.destroy(err);
        reject(err);
      });
    });
  }

  /** Send a SIP message */
  send(msg: SipMessage): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Not connected');
    }
    const raw = serializeSipMessage(msg);
    console.log(`[SIP TX] ${msg.method ?? `${msg.status} ${msg.reason}`}`);
    this.socket.write(raw);
  }

  /** Close the connection */
  close(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /** Check if connected */
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }
}
