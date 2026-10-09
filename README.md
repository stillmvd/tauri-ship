# tauri-ship

Один способ выпускать и обновлять Tauri 2 приложения на Windows: локальная подписанная сборка, публикация в GitHub Releases в фоне, тост «Перезапустить» в приложении.

## Подключение к приложению

1. Зависимости:
   - `src-tauri/Cargo.toml`: `tauri-plugin-ship = { git = "https://github.com/stillmvd/tauri-ship", tag = "vX.Y.Z" }` и `tauri-plugin-updater = "2.13"`
   - `package.json`: `"@stillmvd/tauri-ship": "github:stillmvd/tauri-ship#vX.Y.Z"`, скрипты `"release": "ship release"`, `"ship": "ship"`, `"check": "<полные проверки проекта>"`
2. `src-tauri/src/lib.rs`:
   ```rust
   .plugin(tauri_plugin_updater::Builder::new().build())
   .plugin(tauri_plugin_ship::init(|app| {
       // сохранить состояние: плагин апдейтера выходит через process::exit мимо RunEvent::Exit
   }))
   ```
3. `src-tauri/capabilities/default.json`: `"ship:default"`.
4. `tauri.conf.json`: `"version": "../package.json"`, `bundle.createUpdaterArtifacts: true`, `bundle.windows.nsis.installMode: "perMachine"`, `bundle.windows.nsis.template: "../node_modules/@stillmvd/tauri-ship/nsis/installer.nsi"`, `plugins.updater.windows.installMode: "passive"`, endpoint `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.
5. Интерфейс: `import '@stillmvd/tauri-ship/ship.css'`, `<UpdateToast lang="ru" />` в корне, `<UpdateBadge />` в тайтлбаре, раздел настроек — на `useShip()` + `checkNow()`. Цвета — через `--ship-bg`, `--ship-fg`, `--ship-muted`, `--ship-accent`, `--ship-accent-fg`, `--ship-accent-soft`, `--ship-warn`, `--ship-hover`, `--ship-border`, `--ship-radius`.
6. Ключ подписи — `~/.tauri/<name из package.json>.key`; сохранить в менеджер паролей и `pnpm ship backup-ok`.
7. `pnpm ship doctor` — всё зелёное. После первого успешного `pnpm release` удалить `.github/workflows/release.yml` и секреты `TAURI_SIGNING_PRIVATE_KEY*`.

## Команды

| Команда | Что делает |
|---|---|
| `pnpm release` | проверки → версия по коммитам → сборка и подпись → коммит и тег → публикация в фоне → установка себе |
| `pnpm ship status` | опубликован / публикуется / упал, хвост лога |
| `pnpm ship publish` | дозалить неопубликованный релиз (идемпотентно) |
| `pnpm ship yank <версия>` | снять битый релиз; кто обновился — останется на нём, лечится следующим релизом |
| `pnpm ship doctor` | проверить конфигурацию приложения |
| `pnpm ship backup-ok` | отметить, что ключи сохранены |

Состояние и лог публикации — `%LOCALAPPDATA%\ship\<name>\`.

## Обновление пакета

Правка здесь → `pnpm run check` → тег `vX.Y.Z` → поднять тег в каждом приложении. NSIS-шаблон снят с версии `@tauri-apps/cli` из `nsis/UPSTREAM`; при обновлении CLI перенести две правки в новый шаблон, иначе `ship doctor` остановит релиз.

---

# Стандарт


## Рамки

- Пользователь ПК-приложений — автор (одна машина). Authenticode нет, SmartScreen при первой установке терпим.
- Приложения: Booked, Cache Out, Echo Studio, Markdown, Sorter, Trail, Waypoint. Click It, Folderize, Link Gate — вне рамок.
- Темп: пару релизов в неделю. Хостинг: публичные GitHub Releases, `tauri-plugin-updater`, endpoint `…/releases/latest/download/latest.json`.
- Установка: NSIS perMachine (Program Files), **installMode `passive` везде** — `quiet` + perMachine не может поднять права и молча не ставится `[A1]`. UAC на обновление принят.
- Ключ minisign на приложение (`~/.tauri/<app>.key`); endpoint и pubkey не меняются никогда, иначе установленные копии перестанут обновляться.
- **Бэкап ключей — в менеджере паролей** `[A14]`; `ship doctor` напоминает, если ключ не отмечен как сохранённый. Релиз — только с основного ПК.

## Общий пакет `stillmvd/tauri-ship` (публичный, подключение по git-тегу)

- **Rust-крейт**: команды check/download/install/status; состояние под `Mutex` — `Idle | Checking | Downloading | Ready(version, bytes) | Error` (single-flight) `[A13]`; байты сбрасываются только при смене версии `[A16]`; `install()` получает **клон** байтов — при отказе UAC плагин возвращает `Err` и не выходит, обновление остаётся готовым, тост показывает «нет прав — повторить» `[A2]`; `on_before_exit` вызывает хук приложения (flush, window-state, бэкап), т.к. плагин делает `process::exit(0)` мимо `RunEvent::Exit` `[A8]`; чистка `%TEMP%\<App>-*-updater-*` при старте.
- **React-пакет**: `useUpdater()`, `<UpdateToast>`, `<UpdateBadge>`, `<UpdatesSection>`; стиль через переменные `--ship-*`, каждое приложение маппит их на свои токены `[A20]`.
- **NSIS-шаблон**: один форк в пакете (perMachine, после установки запускать приложение), приложения ссылаются на него через `bundle.windows.nsis.template` `[A12]`.
- **CLI `ship`** (Node, без зависимостей): `release`, `publish` (дозалить), `status`, `yank`, `doctor`.
- **`ship doctor`** падает, если: `installMode` ≠ `passive`; версия не из `package.json`; minor `tauri` (crate) ≠ minor `@tauri-apps/api`; не тот NSIS-шаблон; нет ключа/отметки бэкапа; `gh auth` не ок `[A1, A9, A10, A12, A14]`.
- **Предусловие пакета**: во всех 7 приложениях выровнять одну minor tauri (сейчас 2.11.5 и 2.12.0) `[A10]`.

## Релиз: `pnpm release` (локально)

1. **Предусловия**: `ship doctor` чист; ветка `main`, дерево чистое, `git fetch` — не отстаём; нет незавершённой публикации (иначе — `ship publish`).
2. **Версия** по коммитам с последнего `v*`: `feat` → minor, остальное → patch, `!`/`BREAKING` → major. Нечего выпускать — стоп. План `0.5.1 → 0.6.0` + notes → одно `y`.
3. **Проверки**: `pnpm check` проекта. Упало — стоп, ничего не тронуто.
4. **Версия в файлы** (`package.json`, `Cargo.toml`, `Cargo.lock`) → **сборка** (`tauri build`, ключ через `TAURI_SIGNING_PRIVATE_KEY`). Упало — файлы версии откатываются `git checkout`, дерево снова чистое `[A6]`.
5. **Коммит + тег локально**: `chore(release): X.Y.Z`, `vX.Y.Z`. Notes (feat/fix с прошлого тега) и `latest.json` с нормализованным именем ассета (без пробелов; `.sig` и url — одно имя) `[A18]`.
6. **Поставить себе**: закрыть приложение мягко (`taskkill` без `/F`, ждать выхода; трей-приложения сохраняют состояние в хуке) → NSIS passive (один UAC) → приложение стартует само `[A7]`.
7. **Фоновая публикация** — через одноразовую задачу Планировщика (`schtasks /create … /run`), а не `detached` из терминала: процессы Claude Code / Windows Terminal живут в job-объекте и умирают вместе с ним `[A3]`. Лог — `%LOCALAPPDATA%\ship\<app>\publish.log`, состояние — там же.
   - `git push origin <sha>:refs/heads/main refs/tags/vX.Y.Z` — пушится ровно релизный коммит, а не то, что накопилось в `main` за время сборки `[A5]`.
   - Один `gh release create vX.Y.Z <setup.exe> <.sig> latest.json --latest --notes …` — gh сам грузит в черновик и публикует после загрузки; клиенты не видят полурелиз `[A4]`.
   - Перед дозаливом проверить, что `vX.Y.Z` ≥ текущего latest, иначе старая версия станет «latest» `[A4]`.
   - 3 попытки с паузой; провал — уведомление Windows «<App> X.Y.Z не опубликован · `pnpm ship publish`».
8. **`ship status`**: «опубликовано / идёт (pid) / упало — локально стоит неопубликованная X» `[A6]`.

## В приложении (одинаково везде)

1. Старт: чистка `%TEMP%`; через ~5 с первая проверка.
2. Проверки: каждый час + фокус окна, если прошло > 10 мин. Одна за раз.
3. Новая версия → скачать в фоне (подпись проверяет плагин). Сетевые ошибки — только в настройках.
4. Скачано → тост в углу: «Версия X готова» + notes, «Перезапустить» / «Позже».
5. «Позже» → значок «↑» в тайтлбаре (клик возвращает тост); тост снова при следующем запуске или на более новой версии. Повторно ту же версию не качать.
6. «Перезапустить» → хук → `install()` → UAC → NSIS passive → приложение стартует. Отказ UAC — приложение живо, тост «нет прав — повторить».
7. Настройки → Обновления: версия, «Проверить», «проверено N мин назад», последняя ошибка. Без выключателя.

## Битый релиз

`ship yank vX.Y.Z` (удалить релиз, тег оставить) → `latest` возвращается к прошлой версии для тех, кто не обновился. Обновившиеся остаются на битой — апдейтер не откатывает; лечится только следующим релизом (fix forward, минуты при локальной сборке) `[A15]`.

## Миграция

1. Выровнять tauri во всех приложениях; забэкапить ключи.
2. Создать `tauri-ship`, пилот — Echo Studio: `ship release` на реальной версии.
3. Только после успешного пилота в приложении — удалить его `release.yml` и секрет `TAURI_SIGNING_PRIVATE_KEY` `[A11]`.
4. Порядок остальных: Booked, Trail, Cache Out, Markdown, Sorter, Waypoint.
5. Cache Out, Markdown, Sorter (сейчас `quiet`): старый апдейтер может не поставить обновление `[A1, A19]` — первую новую версию ставит себе сам `pnpm release`.
6. Sorter, Cache Out: убрать литерал версии из `tauri.conf.json`.
7. Waypoint: свой `release.mjs` остаётся (APK, составной тег, отдельный `waypoint-releases`, из него обновляется Android) — переводится только приложение (плагин, тост, passive); CLI `ship` не используется `[A9]`.
