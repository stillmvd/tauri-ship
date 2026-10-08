#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import * as lib from './lib.mjs';

const CLI = fileURLToPath(import.meta.url);
const PKG_DIR = resolve(dirname(CLI), '..');
const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const BACKUP_MARK = join(homedir(), '.tauri', '.backup-ok');

class Fail extends Error {}
const fail = (message) => {
  throw new Fail(message);
};

function sh(cmd, cmdArgs = [], { capture = false, allowFail = false, env, shell = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    shell,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    fail(`${[cmd, ...cmdArgs].join(' ')} — код ${r.status}${capture ? `\n${(r.stderr || r.stdout || '').trim()}` : ''}`);
  }
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

const git = (gitArgs, opts) => sh('git', gitArgs, { capture: true, ...opts }).stdout;
const readJson = (path) => {
  try {
    return JSON.parse(lib.stripBom(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const step = (title) => console.log(`\n▸ ${title}`);
const stamp = () => new Date().toISOString();

function context() {
  const pkgPath = join(ROOT, 'package.json');
  const tauriDir = join(ROOT, 'src-tauri');
  const confPath = join(tauriDir, 'tauri.conf.json');
  if (!existsSync(pkgPath) || !existsSync(confPath)) {
    fail('Запускать из корня Tauri-приложения (нужны package.json и src-tauri/tauri.conf.json)');
  }
  const pkg = readJson(pkgPath);
  const conf = readJson(confPath);
  const name = pkg.name;
  const product = conf.productName;
  return {
    pkg,
    conf,
    name,
    product,
    tauriDir,
    exe: `${conf.mainBinaryName ?? lib.cargoName(readFileSync(join(tauriDir, 'Cargo.toml'), 'utf8')) ?? product}.exe`,
    repo: lib.repoFromEndpoint(conf.plugins?.updater?.endpoints?.[0]),
    key: join(homedir(), '.tauri', `${name}.key`),
    stateDir: join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ship', name),
    task: `ship-${name}`,
  };
}

function readState(ctx) {
  return readJson(join(ctx.stateDir, 'state.json'));
}

function writeState(ctx, state) {
  mkdirSync(ctx.stateDir, { recursive: true });
  writeFileSync(join(ctx.stateDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function doctor(ctx) {
  const errors = [];
  const warnings = [];
  const { pkg, conf } = ctx;
  const cargoText = readFileSync(join(ctx.tauriDir, 'Cargo.toml'), 'utf8');
  const lockText = existsSync(join(ctx.tauriDir, 'Cargo.lock')) ? readFileSync(join(ctx.tauriDir, 'Cargo.lock'), 'utf8') : '';

  if (!pkg.scripts?.check) errors.push('package.json: нет скрипта "check" — полные проверки перед релизом');
  if (conf.version !== '../package.json') errors.push('tauri.conf.json: "version" должен быть "../package.json" — версия живёт в одном месте');
  const cargoVersion = cargoText.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1];
  if (cargoVersion !== pkg.version) errors.push(`Cargo.toml: версия ${cargoVersion}, в package.json ${pkg.version}`);

  const bundle = conf.bundle ?? {};
  if (bundle.createUpdaterArtifacts !== true) errors.push('tauri.conf.json: bundle.createUpdaterArtifacts должен быть true');
  if (!(bundle.targets === 'all' || (Array.isArray(bundle.targets) && bundle.targets.includes('nsis')))) {
    errors.push('tauri.conf.json: bundle.targets должен включать "nsis"');
  }
  const nsis = bundle.windows?.nsis ?? {};
  if (nsis.installMode !== 'perMachine') errors.push('tauri.conf.json: bundle.windows.nsis.installMode должен быть "perMachine"');
  const ownTemplate = readFileSync(join(PKG_DIR, 'nsis', 'installer.nsi'), 'utf8');
  const template = nsis.template ? resolve(ctx.tauriDir, nsis.template) : null;
  if (!template || !existsSync(template) || readFileSync(template, 'utf8') !== ownTemplate) {
    errors.push('tauri.conf.json: bundle.windows.nsis.template → "../node_modules/@stillmvd/tauri-ship/nsis/installer.nsi"');
  }

  const updater = conf.plugins?.updater;
  if (updater?.windows?.installMode !== 'passive') {
    errors.push('tauri.conf.json: plugins.updater.windows.installMode должен быть "passive" — quiet при perMachine не поднимает права, обновление молча не ставится');
  }
  if (!updater?.pubkey) errors.push('tauri.conf.json: нет plugins.updater.pubkey');
  if (!ctx.repo) errors.push('tauri.conf.json: endpoint должен быть https://github.com/<owner>/<repo>/releases/latest/download/latest.json');

  const upstream = readFileSync(join(PKG_DIR, 'nsis', 'UPSTREAM'), 'utf8').match(/tag: tauri-cli-v(\S+)/)?.[1];
  const cli = readJson(join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'package.json'))?.version;
  if (cli !== upstream) {
    errors.push(`@tauri-apps/cli ${cli}, а NSIS-шаблон tauri-ship снят с ${upstream} — перенести правки шаблона в tauri-ship или закрепить CLI`);
  }
  const crate = lib.lockVersion(lockText, 'tauri');
  const api = readJson(join(ROOT, 'node_modules', '@tauri-apps', 'api', 'package.json'))?.version;
  if (!crate || !api || lib.minorOf(crate) !== lib.minorOf(api)) {
    errors.push(`crate tauri ${crate} и @tauri-apps/api ${api} — разные minor, tauri build упадёт`);
  }

  if (!existsSync(ctx.key)) {
    errors.push(`нет ключа подписи ${ctx.key}`);
  } else if (!existsSync(BACKUP_MARK) || statSync(BACKUP_MARK).mtimeMs < statSync(ctx.key).mtimeMs) {
    warnings.push(`ключ ${ctx.key} не отмечен как сохранённый — положите его в менеджер паролей и выполните: pnpm ship backup-ok`);
  }
  if (sh('gh', ['auth', 'status'], { capture: true, allowFail: true }).status !== 0) errors.push('gh не авторизован: gh auth login');
  return { errors, warnings };
}

function printDoctor({ errors, warnings }) {
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  if (errors.length === 0) console.log('  ✓ конфигурация в порядке');
}

function gitChecks() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') fail(`релиз только из main (сейчас ${branch})`);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) fail(`есть незакоммиченные изменения:\n${dirty}`);
  sh('git', ['fetch', 'origin', '--quiet', '--tags']);
  const behind = git(['rev-list', '--count', 'HEAD..origin/main']);
  if (behind !== '0') fail(`main отстаёт от origin/main на ${behind} — сначала git pull`);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  if (untracked) console.log(`  ! не в git (в сборку не попадут, если не импортируются):\n${untracked.replace(/^/gm, '    ')}`);
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim()) || /^д(а)?$/i.test(answer.trim());
}

function bumpFiles(ctx, version) {
  const pkgPath = join(ROOT, 'package.json');
  writeFileSync(pkgPath, lib.setPackageVersion(readFileSync(pkgPath, 'utf8'), version));
  const cargoPath = join(ctx.tauriDir, 'Cargo.toml');
  const cargoText = readFileSync(cargoPath, 'utf8');
  writeFileSync(cargoPath, lib.setCargoVersion(cargoText, version));
  const lockPath = join(ctx.tauriDir, 'Cargo.lock');
  if (existsSync(lockPath)) {
    writeFileSync(lockPath, lib.setLockVersion(readFileSync(lockPath, 'utf8'), lib.cargoName(cargoText), version));
  }
}

const VERSION_FILES = ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];

async function release(ctx) {
  step('Проверка конфигурации');
  const report = doctor(ctx);
  printDoctor(report);
  if (report.errors.length) fail('исправьте конфигурацию — pnpm ship doctor');

  const previous = readState(ctx);
  if (previous && previous.status !== 'published') {
    fail(`${previous.version} ещё не опубликован (${previous.status}) — pnpm ship publish, подробности: pnpm ship status`);
  }
  gitChecks();

  const lastTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], { allowFail: true }) || null;
  const commits = lib.parseCommits(git(['log', lastTag ? `${lastTag}..HEAD` : 'HEAD', '--format=%H%x1f%s%x1f%b%x1e']));
  const next = lib.nextVersion(ctx.pkg.version, commits);
  if (!next) {
    console.log(`\nНечего выпускать: после ${lastTag} нет коммитов.`);
    return;
  }
  const version = next.version;
  const tag = `v${version}`;
  if (git(['tag', '--list', tag])) fail(`тег ${tag} уже есть`);
  const notes = lib.releaseNotes(commits);
  const why = next.because;
  console.log(`\n${ctx.product}: ${ctx.pkg.version} → ${version}  (${next.bump}: ${why.type}${why.scope ? `(${why.scope})` : ''}: ${why.subject})`);
  console.log(`Коммитов: ${commits.length}. Что нового:\n${notes.replace(/^/gm, '  ')}`);
  console.log('Дальше: проверки → сборка → коммит и тег → публикация в фоне → установка себе.');
  if (!flag('yes') && !(await confirm('Выпускаем?'))) return;

  step('Проверки проекта (pnpm run check)');
  sh('pnpm run check', [], { shell: true });

  step(`Версия ${version}`);
  bumpFiles(ctx, version);
  const nsisDir = join(ctx.tauriDir, 'target', 'release', 'bundle', 'nsis');
  const exePath = join(nsisDir, `${ctx.product}_${version}_x64-setup.exe`);
  try {
    step('Сборка и подпись (pnpm tauri build)');
    sh('pnpm tauri build', [], {
      shell: true,
      env: { TAURI_SIGNING_PRIVATE_KEY: readFileSync(ctx.key, 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' },
    });
    if (!existsSync(exePath) || !existsSync(`${exePath}.sig`)) fail(`сборка не создала ${exePath} и .sig`);
  } catch (e) {
    sh('git', ['checkout', '--', ...VERSION_FILES], { allowFail: true });
    console.log('  версия откачена, дерево снова чистое');
    throw e;
  }

  step(`Коммит и тег ${tag}`);
  sh('git', ['add', ...VERSION_FILES]);
  sh('git', ['commit', '-m', `chore(release): ${version}`]);
  sh('git', ['tag', tag]);
  const sha = git(['rev-parse', 'HEAD']);

  const dir = join(ctx.stateDir, tag);
  mkdirSync(dir, { recursive: true });
  const asset = lib.assetName(ctx.product, version);
  const signature = readFileSync(`${exePath}.sig`, 'utf8').trim();
  copyFileSync(exePath, join(dir, asset));
  writeFileSync(join(dir, `${asset}.sig`), signature);
  writeFileSync(join(dir, 'notes.md'), `${notes}\n`);
  writeFileSync(
    join(dir, 'latest.json'),
    `${JSON.stringify(lib.latestJson({ version, notes, pubDate: stamp(), signature, repo: ctx.repo, asset }), null, 2)}\n`,
  );
  writeState(ctx, {
    version,
    tag,
    sha,
    repo: ctx.repo,
    product: ctx.product,
    dir,
    files: [asset, `${asset}.sig`, 'latest.json'],
    status: 'pending',
    createdAt: stamp(),
    error: null,
  });

  step('Публикация в фоне');
  schedulePublish(ctx);
  console.log(`  идёт отдельно от терминала; лог: ${join(ctx.stateDir, 'publish.log')}; статус: pnpm ship status`);

  step('Установка себе');
  installLocally(ctx, exePath);
}

function schedulePublish(ctx) {
  mkdirSync(ctx.stateDir, { recursive: true });
  const log = join(ctx.stateDir, 'publish.log');
  const cmd = join(ctx.stateDir, 'publish.cmd');
  const vbs = join(ctx.stateDir, 'publish.vbs');
  writeFileSync(cmd, `@echo off\r\ncd /d "${ROOT}"\r\n"${process.execPath}" "${CLI}" publish --from-task >> "${log}" 2>&1\r\n`);
  writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${cmd}""", 0, False\r\n`);
  sh('schtasks', ['/Create', '/F', '/TN', ctx.task, '/TR', `wscript.exe "${vbs}"`, '/SC', 'ONCE', '/ST', '00:00'], {
    capture: true,
  });
  sh('schtasks', ['/Run', '/TN', ctx.task], { capture: true });
}

function isRunning(exe) {
  const out = sh('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH'], { capture: true, allowFail: true }).stdout;
  return out.toLowerCase().includes(exe.toLowerCase());
}

function installLocally(ctx, exePath) {
  if (isRunning(ctx.exe)) {
    sh('taskkill', ['/IM', ctx.exe], { capture: true, allowFail: true });
    for (let i = 0; i < 30 && isRunning(ctx.exe); i++) sleep(500);
    if (isRunning(ctx.exe)) {
      console.log(`  ${ctx.exe} не закрылся сам (свёрнут в трей?). Закройте его и запустите:\n  ${exePath}`);
      return;
    }
  }
  const ps = `$p = Start-Process -FilePath '${exePath.replaceAll("'", "''")}' -ArgumentList '/P' -Verb RunAs -PassThru; $p.WaitForExit(); exit $p.ExitCode`;
  const r = sh('powershell', ['-NoProfile', '-Command', ps], { capture: true, allowFail: true });
  if (r.status === 0) console.log(`  установлено, ${ctx.product} запускается`);
  else console.log(`  не установилось (UAC отклонён?) — установщик: ${exePath}\n  ${r.stderr}`);
}

function notify(title, body) {
  const q = (s) => String(s).replaceAll("'", "''");
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    "$x = $t.GetElementsByTagName('text')",
    `$x.Item(0).AppendChild($t.CreateTextNode('${q(title)}')) > $null`,
    `$x.Item(1).AppendChild($t.CreateTextNode('${q(body)}')) > $null`,
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
  ].join('; ');
  sh('powershell', ['-NoProfile', '-Command', ps], { capture: true, allowFail: true });
}

async function verifyLatest(st) {
  const url = `https://github.com/${st.repo}/releases/latest/download/latest.json`;
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', cache: 'no-store' });
      if (res.ok && (await res.json()).version === st.version) return;
    } catch {}
    sleep(10_000);
  }
  fail(`${url} не отдаёт ${st.version}`);
}

async function publishOnce(st) {
  sh('git', ['fetch', 'origin', '--quiet']);
  const onRemote = sh('git', ['merge-base', '--is-ancestor', st.sha, 'origin/main'], { allowFail: true, capture: true }).status === 0;
  sh('git', ['push', 'origin', ...(onRemote ? [] : [`${st.sha}:refs/heads/main`]), `refs/tags/${st.tag}`], { capture: true });

  const latest = sh('gh', ['release', 'view', '--repo', st.repo, '--json', 'tagName', '-q', '.tagName'], {
    capture: true,
    allowFail: true,
  }).stdout;
  const makeLatest = !latest || lib.compareVersions(st.version, latest.replace(/^v/, '')) >= 0;
  const files = st.files.map((f) => join(st.dir, f));
  const exists = sh('gh', ['release', 'view', st.tag, '--repo', st.repo, '--json', 'isDraft'], { capture: true, allowFail: true }).status === 0;
  if (!exists) {
    sh(
      'gh',
      ['release', 'create', st.tag, ...files, '--repo', st.repo, '--title', `${st.product} ${st.version}`, '--notes-file', join(st.dir, 'notes.md'), '--verify-tag', `--latest=${makeLatest}`],
      { capture: true },
    );
  } else {
    sh('gh', ['release', 'upload', st.tag, ...files, '--repo', st.repo, '--clobber'], { capture: true });
    sh('gh', ['release', 'edit', st.tag, '--repo', st.repo, '--draft=false', `--latest=${makeLatest}`], { capture: true });
  }
  if (makeLatest) await verifyLatest(st);
}

async function publish(ctx) {
  const st = readState(ctx);
  if (!st) fail('нечего публиковать');
  if (st.status === 'published') {
    console.log(`${st.product} ${st.version} уже опубликован`);
    return;
  }
  console.log(`[${stamp()}] публикация ${st.product} ${st.version}`);
  writeState(ctx, { ...st, status: 'publishing', pid: process.pid, error: null });
  let error = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await publishOnce(st);
      writeState(ctx, { ...st, status: 'published', pid: null, error: null, publishedAt: stamp() });
      console.log(`[${stamp()}] опубликовано`);
      notify(`${st.product} ${st.version} опубликован`, 'Другие машины получат обновление в течение часа');
      return;
    } catch (e) {
      error = e.message;
      console.log(`[${stamp()}] попытка ${attempt}: ${error}`);
      if (attempt < 3) sleep(30_000 * attempt);
    }
  }
  writeState(ctx, { ...st, status: 'failed', pid: null, error });
  notify(`${st.product} ${st.version} не опубликован`, `pnpm ship publish · ${error.slice(0, 120)}`);
  process.exitCode = 1;
}

function status(ctx) {
  const st = readState(ctx);
  if (!st) {
    console.log('Релизов через ship ещё не было.');
    return;
  }
  const alive = Boolean(st.pid) && sh('tasklist', ['/FI', `PID eq ${st.pid}`, '/NH'], { capture: true }).stdout.includes(String(st.pid));
  const label = {
    published: 'опубликован',
    pending: 'ждёт публикации',
    publishing: alive ? `публикуется (pid ${st.pid})` : 'публикация прервалась',
    failed: 'публикация упала',
  }[st.status];
  console.log(`${st.product} ${st.version}: ${label}`);
  if (st.status !== 'published') console.log(`  у вас может стоять неопубликованная ${st.version}; дозалить: pnpm ship publish`);
  if (st.error) console.log(`  ошибка: ${st.error}`);
  const log = join(ctx.stateDir, 'publish.log');
  if (existsSync(log)) console.log(`  лог: ${log}\n${readFileSync(log, 'utf8').trim().split('\n').slice(-5).join('\n').replace(/^/gm, '    ')}`);
}

async function yank(ctx) {
  const version = args[1]?.replace(/^v/, '');
  if (!version) fail('pnpm ship yank <версия>');
  console.log(`Удалить релиз v${version} из ${ctx.repo}? Тег останется. Кто уже обновился — останется на нём; лечится только следующим релизом.`);
  if (!flag('yes') && !(await confirm('Удаляем?'))) return;
  sh('gh', ['release', 'delete', `v${version}`, '--repo', ctx.repo, '--yes']);
  console.log('Готово: latest теперь указывает на предыдущий релиз.');
}

function backupOk() {
  mkdirSync(dirname(BACKUP_MARK), { recursive: true });
  if (!existsSync(BACKUP_MARK)) closeSync(openSync(BACKUP_MARK, 'w'));
  const now = new Date();
  utimesSync(BACKUP_MARK, now, now);
  console.log('Отмечено: ключи из ~/.tauri сохранены в менеджере паролей.');
}

const commands = {
  release: async () => release(context()),
  publish: async () => {
    const ctx = context();
    try {
      await publish(ctx);
    } finally {
      if (flag('from-task')) sh('schtasks', ['/Delete', '/F', '/TN', ctx.task], { capture: true, allowFail: true });
    }
  },
  status: async () => status(context()),
  yank: async () => yank(context()),
  doctor: async () => {
    const report = doctor(context());
    printDoctor(report);
    if (report.errors.length) process.exitCode = 1;
  },
  'backup-ok': async () => backupOk(),
};

const run = commands[args[0]];
if (!run) {
  console.log('ship release | publish | status | yank <версия> | doctor | backup-ok');
  process.exitCode = args[0] ? 1 : 0;
} else {
  try {
    await run();
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    console.error(`\n✗ ${e.message}`);
    process.exitCode = 1;
  }
}
