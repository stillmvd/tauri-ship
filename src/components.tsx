import { dismiss, installNow, noteLines, reopen, useShip } from './store';

export type Lang = 'en' | 'ru';

const text = {
  en: {
    ready: (v: string) => `Version ${v} is ready`,
    installing: 'Installing — the app will restart',
    restart: 'Restart',
    later: 'Later',
    retry: 'Try again',
    failed: "Didn't install",
    badge: (v: string) => `Version ${v} is ready — click to update`,
  },
  ru: {
    ready: (v: string) => `Версия ${v} готова`,
    installing: 'Устанавливается — приложение перезапустится',
    restart: 'Перезапустить',
    later: 'Позже',
    retry: 'Повторить',
    failed: 'Не установилось',
    badge: (v: string) => `Версия ${v} готова — нажмите, чтобы обновить`,
  },
};

function ArrowUp() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

export function UpdateToast({ lang = 'en' }: { lang?: Lang }) {
  const { status, toastOpen } = useShip();
  if (!toastOpen || !status?.available) return null;
  const t = text[lang];
  const installing = status.phase === 'installing';
  const lines = noteLines(status.available.notes);
  return (
    <section className="ship-toast" role="status" aria-live="polite">
      <p className="ship-toast-title">
        <ArrowUp />
        {installing ? t.installing : t.ready(status.available.version)}
      </p>
      {!installing && lines.length > 0 && (
        <ul className="ship-toast-notes">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {status.error && !installing && (
        <p className="ship-toast-error" title={status.error}>
          {t.failed}: {status.error}
        </p>
      )}
      {!installing && (
        <div className="ship-toast-actions">
          <button type="button" className="ship-button ship-button-ghost" onClick={dismiss}>
            {t.later}
          </button>
          <button
            type="button"
            className="ship-button ship-button-primary"
            onClick={() => {
              installNow().catch(() => {});
            }}
          >
            {status.error ? t.retry : t.restart}
          </button>
        </div>
      )}
    </section>
  );
}

export function UpdateBadge({ lang = 'en' }: { lang?: Lang }) {
  const { status, badgeVisible } = useShip();
  if (!badgeVisible || !status?.available) return null;
  const label = text[lang].badge(status.available.version);
  return (
    <button type="button" className="ship-badge" onClick={reopen} title={label} aria-label={label}>
      <ArrowUp />
      {status.available.version}
    </button>
  );
}
