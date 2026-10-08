import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { dismiss, installNow, noteLines, reopen, useShip } from './store';
const text = {
    en: {
        ready: (v) => `Version ${v} is ready`,
        installing: 'Installing — the app will restart',
        restart: 'Restart',
        later: 'Later',
        retry: 'Try again',
        failed: "Didn't install",
        badge: (v) => `Version ${v} is ready — click to update`,
    },
    ru: {
        ready: (v) => `Версия ${v} готова`,
        installing: 'Устанавливается — приложение перезапустится',
        restart: 'Перезапустить',
        later: 'Позже',
        retry: 'Повторить',
        failed: 'Не установилось',
        badge: (v) => `Версия ${v} готова — нажмите, чтобы обновить`,
    },
};
function ArrowUp() {
    return (_jsx("svg", { "aria-hidden": "true", viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", children: _jsx("path", { d: "M8 13V3M3.5 7.5 8 3l4.5 4.5" }) }));
}
export function UpdateToast({ lang = 'en' }) {
    const { status, toastOpen } = useShip();
    if (!toastOpen || !status?.available)
        return null;
    const t = text[lang];
    const installing = status.phase === 'installing';
    const lines = noteLines(status.available.notes);
    return (_jsxs("section", { className: "ship-toast", role: "status", "aria-live": "polite", children: [_jsxs("p", { className: "ship-toast-title", children: [_jsx(ArrowUp, {}), installing ? t.installing : t.ready(status.available.version)] }), !installing && lines.length > 0 && (_jsx("ul", { className: "ship-toast-notes", children: lines.map((line) => (_jsx("li", { children: line }, line))) })), status.error && !installing && (_jsxs("p", { className: "ship-toast-error", title: status.error, children: [t.failed, ": ", status.error] })), !installing && (_jsxs("div", { className: "ship-toast-actions", children: [_jsx("button", { type: "button", className: "ship-button ship-button-ghost", onClick: dismiss, children: t.later }), _jsx("button", { type: "button", className: "ship-button ship-button-primary", onClick: () => {
                            installNow().catch(() => { });
                        }, children: status.error ? t.retry : t.restart })] }))] }));
}
export function UpdateBadge({ lang = 'en' }) {
    const { status, badgeVisible } = useShip();
    if (!badgeVisible || !status?.available)
        return null;
    const label = text[lang].badge(status.available.version);
    return (_jsxs("button", { type: "button", className: "ship-badge", onClick: reopen, title: label, "aria-label": label, children: [_jsx(ArrowUp, {}), status.available.version] }));
}
