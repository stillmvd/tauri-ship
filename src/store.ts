import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';

export type Phase = 'idle' | 'checking' | 'downloading' | 'ready' | 'installing';

export interface Available {
  version: string;
  notes: string | null;
}

export interface ShipStatus {
  current: string;
  phase: Phase;
  available: Available | null;
  downloaded: number;
  total: number | null;
  lastCheck: number | null;
  error: string | null;
}

interface State {
  status: ShipStatus | null;
  dismissed: string | null;
}

let state: State = { status: null, dismissed: null };
const listeners = new Set<() => void>();
let started = false;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

function start() {
  if (started) return;
  started = true;
  listen<ShipStatus>('ship://status', (e) => set({ status: e.payload })).catch(() => {});
  invoke<ShipStatus>('plugin:ship|status')
    .then((status) => set({ status }))
    .catch(() => {});
}

function subscribe(fn: () => void) {
  start();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function checkNow(): Promise<ShipStatus> {
  return invoke<ShipStatus>('plugin:ship|check');
}

export function installNow(): Promise<void> {
  return invoke<void>('plugin:ship|install');
}

export function dismiss() {
  set({ dismissed: state.status?.available?.version ?? null });
}

export function reopen() {
  set({ dismissed: null });
}

export function useShip() {
  const { status, dismissed } = useSyncExternalStore(subscribe, () => state);
  const version = status?.available?.version ?? null;
  const ready = status?.phase === 'ready' || status?.phase === 'installing';
  return {
    status,
    toastOpen: ready && (status?.phase === 'installing' || dismissed !== version),
    badgeVisible: status?.phase === 'ready' && dismissed === version,
  };
}

export function noteLines(notes: string | null): string[] {
  if (!notes) return [];
  return notes
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}
