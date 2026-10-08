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
export declare function checkNow(): Promise<ShipStatus>;
export declare function installNow(): Promise<void>;
export declare function dismiss(): void;
export declare function reopen(): void;
export declare function useShip(): {
    status: ShipStatus | null;
    toastOpen: boolean;
    badgeVisible: boolean;
};
export declare function noteLines(notes: string | null): string[];
