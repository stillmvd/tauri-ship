const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

export function parseCommits(raw) {
  return raw
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha = '', subject = '', body = ''] = chunk.split('\x1f');
      const m = subject.match(HEADER);
      return {
        sha,
        type: m ? m[1].toLowerCase() : 'other',
        scope: m?.[2] ?? null,
        breaking: Boolean(m?.[3]) || /^BREAKING[ -]CHANGE:/m.test(body),
        subject: m ? m[4].trim() : subject.trim(),
      };
    })
    .filter((c) => !(c.type === 'chore' && c.scope === 'release'));
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function nextVersion(current, commits) {
  if (commits.length === 0) return null;
  const [major = 0, minor = 0, patch = 0] = current.split('.').map(Number);
  const breaking = commits.find((c) => c.breaking);
  if (breaking) return { version: `${major + 1}.0.0`, bump: 'major', because: breaking };
  const feat = commits.find((c) => c.type === 'feat');
  if (feat) return { version: `${major}.${minor + 1}.0`, bump: 'minor', because: feat };
  return { version: `${major}.${minor}.${patch + 1}`, bump: 'patch', because: commits[0] };
}

function sentence(subject) {
  return subject.charAt(0).toUpperCase() + subject.slice(1);
}

export function releaseNotes(commits) {
  const feats = commits.filter((c) => c.type === 'feat' || (c.breaking && c.type !== 'fix'));
  const fixes = commits.filter((c) => c.type === 'fix');
  const lines = [...feats, ...fixes].map((c) => `- ${sentence(c.subject)}`);
  return [...new Set(lines)].join('\n') || '- Maintenance release';
}

export function assetName(productName, version) {
  return `${productName.replaceAll(' ', '.')}_${version}_x64-setup.exe`;
}

export function repoFromEndpoint(url) {
  const m = String(url).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/latest\.json$/);
  return m ? m[1] : null;
}

export function latestJson({ version, notes, pubDate, signature, repo, asset }) {
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      'windows-x86_64': {
        signature,
        url: `https://github.com/${repo}/releases/download/v${version}/${asset}`,
      },
    },
  };
}

export function setPackageVersion(text, version) {
  return text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
}

export function setCargoVersion(text, version) {
  return text.replace(/(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/, `$1${version}$2`);
}

export function cargoName(text) {
  return text.match(/\[package\][\s\S]*?\nname\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

export function setLockVersion(text, name, version) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${escaped}"\\r?\\nversion = ")[^"]+(")`), `$1${version}$2`);
}

export function minorOf(version) {
  return String(version).split('.').slice(0, 2).join('.');
}

export function lockVersion(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.match(new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "${escaped}"\\r?\\nversion = "([^"]+)"`))?.[1] ?? null;
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
