/**
 * Lists models available for the API key (generateContent + optional flash filter).
 * Run: node --env-file=.env.local scripts/list-gemini-models.mjs
 * Or set GEMINI_API_KEY in the environment.
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadDotEnvLocal() {
  const p = join(root, '.env.local');
  if (!existsSync(p)) return {};
  const txt = readFileSync(p, 'utf8');
  const out = {};
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = { ...loadDotEnvLocal(), ...process.env };
const key =
  env.GEMINI_API_KEY ||
  env.GOOGLE_API_KEY ||
  env.GOOGLE_GENERATIVE_AI_API_KEY ||
  env.GOOGLE_AI_API_KEY;

if (!key) {
  console.error(
    '[list-gemini-models] API 키 없음: .env.local에 GEMINI_API_KEY(또는 GOOGLE_API_KEY 등)를 설정하세요.'
  );
  process.exit(1);
}

function shortName(full) {
  return String(full || '').replace(/^models\//, '');
}

async function fetchAllModels() {
  const all = [];
  let pageToken = '';
  do {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('key', key);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[list-gemini-models] HTTP', res.status, JSON.stringify(json, null, 2));
      process.exit(1);
    }
    all.push(...(json.models || []));
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return all;
}

const models = await fetchAllModels();
const withGen = models.filter((m) =>
  (m.supportedGenerationMethods || []).includes('generateContent')
);

console.log('\n=== generateContent 지원 + 이름에 flash 포함 (정렬) ===\n');
const flashModels = withGen
  .filter((m) => /flash/i.test(m.name))
  .sort((a, b) => a.name.localeCompare(b.name));
for (const m of flashModels) {
  const id = shortName(m.name);
  const methods = (m.supportedGenerationMethods || []).join(', ');
  console.log(id);
  console.log('  displayName:', m.displayName || '(없음)');
  console.log('  methods:', methods);
  console.log('');
}

console.log('\n=== generateContent 지원 전체 (이름순, flash 아닌 것 일부 포함) ===\n');
for (const m of withGen.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(shortName(m.name));
}
