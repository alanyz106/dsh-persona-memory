/**
 * Admin surface fence tests: the /api/persona-memory/* routes are reachable
 * from the instance's own advertised public authority (a reverse tunnel whose
 * hostname changes on every restart) WITHOUT relaxing the loopback peer
 * requirement.
 *
 * Run after `npm run build`: node test/admin-fence.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { isLoopbackRequest, resolveAllowedHosts } = await import('../dist/lib/admin.js');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

/** Build the minimal request shape the fence inspects. */
function mkReq({ peer = '127.0.0.1', host, origin, fetchSite } = {}) {
  const headers = {};
  if (host !== undefined) headers.host = host;
  if (origin !== undefined) headers.origin = origin;
  if (fetchSite !== undefined) headers['sec-fetch-site'] = fetchSite;
  return { socket: { remoteAddress: peer }, headers };
}

const TUNNEL = 'absence-oecd-conversion-television.trycloudflare.com';

// ---- layer 1: the peer must be loopback, regardless of allowed hosts -------
check('loopback peer + loopback host allowed', isLoopbackRequest(mkReq({ host: '127.0.0.1:3080' })));
check('IPv6 loopback peer allowed', isLoopbackRequest(mkReq({ peer: '::1', host: '[::1]:3080' })));
check('localhost host allowed', isLoopbackRequest(mkReq({ host: 'localhost:3080' })));

// ---- layer 2: tunnel host is rejected unless it is the advertised one -----
check('tunnel host rejected with no allow-list', isLoopbackRequest(mkReq({ host: TUNNEL })) === false);
check('tunnel host allowed when advertised', isLoopbackRequest(mkReq({ host: TUNNEL }), [TUNNEL]));
check('other tunnel host still rejected', isLoopbackRequest(mkReq({ host: 'someone-else.trycloudflare.com' }), [TUNNEL]) === false);

// ---- THE INVARIANT: a non-loopback peer is never accepted -----------------
check(
  'non-loopback peer rejected even with the advertised host',
  isLoopbackRequest(mkReq({ peer: '10.0.0.5', host: TUNNEL }), [TUNNEL]) === false,
);
check(
  'non-loopback peer rejected with a loopback host too',
  isLoopbackRequest(mkReq({ peer: '192.168.1.9', host: 'localhost:3080' })) === false,
);

// ---- layer 3: browser same-origin markers ---------------------------------
check(
  'cross-site fetch rejected',
  isLoopbackRequest(mkReq({ host: TUNNEL, fetchSite: 'cross-site' }), [TUNNEL]) === false,
);
check(
  'matching origin accepted',
  isLoopbackRequest(mkReq({ host: TUNNEL, origin: `https://${TUNNEL}` }), [TUNNEL]),
);
check(
  'mismatched origin rejected',
  isLoopbackRequest(mkReq({ host: TUNNEL, origin: 'https://evil.example' }), [TUNNEL]) === false,
);
check('missing host header rejected', isLoopbackRequest(mkReq({})) === false);

// ---- resolveAllowedHosts: re-reads the URL file per call ------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fence-'));
const urlFile = path.join(tmpDir, 'dsh-url.txt');

fs.writeFileSync(urlFile, `https://${TUNNEL}\n`);
check('url file contributes its authority', resolveAllowedHosts({ adminAllowedHostsFile: urlFile }).includes(TUNNEL));

// A tunnel restart rewrites the file with a NEW hostname; the next call must
// pick it up without any config change (this is the whole point).
fs.writeFileSync(urlFile, 'https://different-tunnel-abc.trycloudflare.com\n');
const after = resolveAllowedHosts({ adminAllowedHostsFile: urlFile });
check('url file change is picked up on the next call', after.includes('different-tunnel-abc.trycloudflare.com'), JSON.stringify(after));
check('previous authority is dropped after the change', after.includes(TUNNEL) === false);

// ---- static extras still work, in both accepted shapes -------------------
check('static array form', resolveAllowedHosts({ adminAllowedHosts: ['a.example.com'], adminAllowedHostsFile: '/nonexistent' }).includes('a.example.com'));
check(
  'static comma/space string form',
  resolveAllowedHosts({ adminAllowedHosts: 'b.example.com, c.example.com', adminAllowedHostsFile: '/nonexistent' }).includes('c.example.com'),
);
check(
  'missing url file contributes nothing (no throw)',
  resolveAllowedHosts({ adminAllowedHostsFile: '/nonexistent/path/url.txt' }).length === 0,
);
check('empty config resolves to no extras', resolveAllowedHosts({ adminAllowedHostsFile: '' }).includes('') === false);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURES`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
