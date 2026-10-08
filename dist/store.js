import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';
let state = { status: null, dismissed: null };
const listeners = new Set();
let started = false;
function set(patch) {
    state = { ...state, ...patch };
    for (const fn of listeners)
        fn();
}
function start() {
    if (started)
        return;
    started = true;
    listen('ship://status', (e) => set({ status: e.payload })).catch(() => { });
    invoke('plugin:ship|status')
        .then((status) => set({ status }))
        .catch(() => { });
}
function subscribe(fn) {
    start();
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}
export function checkNow() {
    return invoke('plugin:ship|check');
}
export function installNow() {
    return invoke('plugin:ship|install');
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
export function noteLines(notes) {
    if (!notes)
        return [];
    return notes
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
}
