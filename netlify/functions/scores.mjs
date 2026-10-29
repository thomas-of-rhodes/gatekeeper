// Gatekeeper shared scoreboard, stored as a plain text file (scores.txt) in your GitHub repo.
//   GET  /api/scores  -> { top: [{ n, s }], total }
//   POST /api/scores  -> appends a line to scores.txt (one commit per game), returns { top, rank, total }
//   GET  /scores.txt  -> the latest scores.txt, straight from GitHub
//
// Netlify environment variables:
//   GITHUB_TOKEN   fine-grained token with Contents: Read and write on this repo only
//   GITHUB_REPO    owner/repo, e.g. yourname/gatekeeper
//   GITHUB_BRANCH  optional, defaults to main
//   SCORES_PATH    optional, defaults to scores.txt

export const config = { path: ['/api/scores', '/scores.txt'] };

const env = k => (globalThis.Netlify && globalThis.Netlify.env && globalThis.Netlify.env.get(k)) || process.env[k];
const HEADER = 'date\tname\tscore\tsecs\ttrays\tpallets\tlorries\twaste\tpeak';
const SEED = [HEADER, '-\tGABO\t400\t0\t0\t0\t0\t0\t0', '-\tVERONICA\t300\t0\t0\t0\t0\t0\t0'].join('\n') + '\n';
const TRAY_MAX = 4 * 5 * 10; // biggest tray value: 4 slots x 5 packs x 10 points

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

function github() {
  const repo = env('GITHUB_REPO'), token = env('GITHUB_TOKEN');
  const branch = env('GITHUB_BRANCH') || 'main', file = env('SCORES_PATH') || 'scores.txt';
  if (!repo || !token) return null;
  const url = `https://api.github.com/repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}`;
  const headers = {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gatekeeper-scoreboard',
  };
  return {
    async read() {
      const r = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
      if (r.status === 404) return { text: SEED, sha: null };
      if (!r.ok) throw new Error(`GitHub read failed: ${r.status} ${await r.text()}`);
      const j = await r.json();
      return { text: Buffer.from(j.content, 'base64').toString('utf8'), sha: j.sha };
    },
    async write(text, sha, message) {
      const body = { message, branch, content: Buffer.from(text, 'utf8').toString('base64') };
      if (sha) body.sha = sha;
      return fetch(url, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    },
  };
}

function parse(text) {
  return text.split('\n').map(l => l.split('\t'))
    .filter(f => f.length >= 3 && f[0] !== 'date' && !f[0].startsWith('#') && /^\d+$/.test(f[2]))
    .map((f, i) => ({ i, name: f[1], score: +f[2] }));
}
const ranked = recs => recs.slice().sort((a, b) => b.score - a.score || a.i - b.i);
const top10 = recs => ranked(recs).slice(0, 10).map(r => ({ n: r.name, s: r.score }));

function validate(b) {
  const name = String(b.name || '').toUpperCase().trim();
  const int = v => (Number.isInteger(v) && v >= 0 ? v : null);
  const score = int(b.score), secs = int(b.secs), trays = int(b.trays);
  if (!/^[A-Z ]{1,8}$/.test(name)) return 'name must be 1 to 8 capital letters';
  if (score === null || secs === null || trays === null) return 'score, secs and trays must be whole numbers';
  if (trays > secs / 4 + 1) return 'too many trays for the time played';
  const maxScore = trays * TRAY_MAX + Math.floor(trays / 8) * 500 + Math.floor(trays / 32) * 2500;
  if (score > maxScore) return 'score is higher than those trays could earn';
  return { name, score, secs, trays, pallets: int(b.pallets) ?? 0, lorries: int(b.lorries) ?? 0, waste: int(b.waste) ?? 0, peak: int(b.peak) ?? 0 };
}

export default async (req) => {
  const gh = github();
  if (!gh) return json({ error: 'Set GITHUB_REPO and GITHUB_TOKEN in Netlify environment variables, then redeploy.' }, 500);
  const url = new URL(req.url);
  try {
    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'expected JSON' }, 400); }
      const rec = validate(body);
      if (typeof rec === 'string') return json({ error: rec }, 400);
      const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const line = [date, rec.name, rec.score, rec.secs, rec.trays, rec.pallets, rec.lorries, rec.waste, rec.peak].join('\t');
      // read, append, write; if someone else saved in between, GitHub rejects the stale write and we retry
      for (let attempt = 0; attempt < 4; attempt++) {
        const { text, sha } = await gh.read();
        const next = (text.endsWith('\n') ? text : text + '\n') + line + '\n';
        const w = await gh.write(next, sha, `Score: ${rec.name} ${rec.score} [skip netlify]`);
        if (w.ok) {
          const recs = parse(next), mine = recs[recs.length - 1];
          return json({ top: top10(recs), rank: ranked(recs).slice(0, 10).indexOf(mine), total: recs.length });
        }
        if (w.status !== 409 && w.status !== 422) throw new Error(`GitHub write failed: ${w.status} ${await w.text()}`);
        await new Promise(r => setTimeout(r, 150 + Math.random() * 300));
      }
      return json({ error: 'scoreboard busy, try again' }, 503);
    }
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const { text } = await gh.read();
    if (url.pathname === '/scores.txt') {
      return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const recs = parse(text);
    return json({ top: top10(recs), total: recs.length });
  } catch (e) {
    console.error(e);
    return json({ error: String(e.message || e) }, 502);
  }
};
