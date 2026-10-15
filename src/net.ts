// Two-player online play over a direct browser-to-browser connection (WebRTC via PeerJS).
// The host's browser owns the game state and the dice; the guest sends intents and
// receives the full state after every change. Only one guest may be connected.

import Peer, { type DataConnection } from 'peerjs';
import type { Action, GameState } from './rules';

export type Intent =
  | { type: 'roll' }
  | { type: 'act'; die: number; action: Action }
  | { type: 'pass'; die: number }
  | { type: 'new' };

type Message =
  | { type: 'state'; state: GameState }
  | { type: 'intent'; intent: Intent }
  | { type: 'full' };

export type NetStatus = 'starting' | 'waiting' | 'connecting' | 'connected' | 'disconnected' | 'full' | 'error';

const PREFIX = 'hexbalance-v1-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newRoomCode(): string {
  return Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
}

export interface HostCallbacks {
  onStatus: (status: NetStatus, detail?: string) => void;
  onIntent: (intent: Intent) => void;
  getState: () => GameState;
}

export class HostSession {
  private peer: Peer | null = null;
  private guest: DataConnection | null = null;
  private destroyed = false;

  constructor(
    readonly code: string,
    private cb: HostCallbacks,
  ) {
    this.open(0);
  }

  private open(attempt: number) {
    if (this.destroyed) return;
    this.cb.onStatus('starting');
    const peer = new Peer(PREFIX + this.code);
    this.peer = peer;
    peer.on('open', () => this.cb.onStatus(this.guest?.open ? 'connected' : 'waiting'));
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('disconnected', () => {
      if (!this.destroyed) peer.reconnect();
    });
    peer.on('error', (err: { type?: string; message?: string }) => {
      // After a reload the old registration can linger for a few seconds; retry the same code.
      if (err.type === 'unavailable-id' && attempt < 8) {
        peer.destroy();
        setTimeout(() => this.open(attempt + 1), 2500);
        return;
      }
      this.cb.onStatus('error', err.message ?? err.type);
    });
  }

  private accept(conn: DataConnection) {
    if (this.guest?.open) {
      conn.on('open', () => {
        conn.send({ type: 'full' } satisfies Message);
        setTimeout(() => conn.close(), 500);
      });
      return;
    }
    this.guest = conn;
    this.cb.onStatus('connecting');
    conn.on('open', () => {
      this.cb.onStatus('connected');
      this.send(this.cb.getState());
    });
    conn.on('data', (raw) => {
      const msg = raw as Message;
      if (msg?.type === 'intent') this.cb.onIntent(msg.intent);
    });
    conn.on('close', () => {
      if (this.guest === conn) {
        this.guest = null;
        if (!this.destroyed) this.cb.onStatus('waiting');
      }
    });
  }

  send(state: GameState) {
    if (this.guest?.open) this.guest.send({ type: 'state', state } satisfies Message);
  }

  destroy() {
    this.destroyed = true;
    this.peer?.destroy();
  }
}

export interface GuestCallbacks {
  onStatus: (status: NetStatus, detail?: string) => void;
  onState: (state: GameState) => void;
}

export class GuestSession {
  private peer: Peer;
  private conn: DataConnection | null = null;
  private destroyed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly code: string,
    private cb: GuestCallbacks,
  ) {
    this.cb.onStatus('starting');
    this.peer = new Peer();
    this.peer.on('open', () => this.connect());
    this.peer.on('disconnected', () => {
      if (!this.destroyed) this.peer.reconnect();
    });
    this.peer.on('error', (err: { type?: string; message?: string }) => {
      if (err.type === 'peer-unavailable') {
        this.cb.onStatus('disconnected', 'Host not found yet. Retrying…');
        this.scheduleRetry();
        return;
      }
      this.cb.onStatus('error', err.message ?? err.type);
    });
  }

  private scheduleRetry() {
    if (this.destroyed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, 3000);
  }

  private connect() {
    if (this.destroyed) return;
    this.cb.onStatus('connecting');
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
    this.conn = conn;
    conn.on('open', () => this.cb.onStatus('connected'));
    conn.on('data', (raw) => {
      const msg = raw as Message;
      if (msg?.type === 'state') this.cb.onState(msg.state);
      if (msg?.type === 'full') {
        this.destroyed = true;
        this.cb.onStatus('full');
      }
    });
    conn.on('close', () => {
      if (this.conn !== conn || this.destroyed) return;
      this.cb.onStatus('disconnected', 'Lost the host. Reconnecting…');
      this.scheduleRetry();
    });
  }

  send(intent: Intent) {
    if (this.conn?.open) this.conn.send({ type: 'intent', intent } satisfies Message);
  }

  destroy() {
    this.destroyed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.peer.destroy();
  }
}
