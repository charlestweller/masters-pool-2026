/**
 * fetch-scores.js
 * Pulls live Masters leaderboard data from ESPN's public API
 * and writes it to data/scores.json.
 *
 * Run automatically by GitHub Actions every 30 minutes.
 * Requires Node.js 18+ (built-in fetch).
 */

const fs   = require('fs');
const path = require('path');

const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard';
const OUT_PATH = path.join(__dirname, '..', 'data', 'scores.json');

// Augusta National par by hole (holes 1–18)
const AUGUSTA_PAR = [4,5,4,3,4,3,4,5,4, 4,4,3,5,4,5,3,4,4]; // total par 72

// Returns cumulative par for `holesPlayed` holes starting at `startHole` (1-indexed)
function cumulativePar(holesPlayed, startHole) {
  let par = 0;
  for (let i = 0; i < holesPlayed; i++) {
    par += AUGUSTA_PAR[(startHole - 1 + i) % 18];
  }
  return par;
}

async function fetchScores() {
  console.log(`[${new Date().toISOString()}] Fetching scores from ESPN…`);

  const res = await fetch(ESPN_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MastersPool/1.0)',
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`ESPN API responded with HTTP ${res.status}`);
  }

  const data = await res.json();

  // ESPN returns a list of events; grab the first (current/featured)
  const event = data.events?.[0];
  if (!event) {
    console.warn('No events found in ESPN response — is there a tournament this week?');
    process.exit(0);
  }

  console.log(`Found event: "${event.name}"`);

  const competition = event.competitions?.[0];
  if (!competition) throw new Error('No competition data found');

  const statusObj = competition.status || {};
  const round     = statusObj.period || 1;
  const statusName = statusObj.type?.name || '';
  const statusDesc = statusObj.type?.shortDetail || statusObj.type?.detail || '';

  // Map ESPN status string to our simple status
  let tournamentStatus = 'scheduled';
  if (statusName.includes('IN_PROGRESS'))   tournamentStatus = 'in-progress';
  else if (statusName.includes('COMPLETE') || statusName.includes('FINAL')) tournamentStatus = 'complete';
  else if (statusName.includes('SCHEDULED')) tournamentStatus = 'scheduled';

  // ── Detailed debug log for first 5 players ───────────────────────────────────
  // (helps identify the right ESPN fields for to-par, especially between rounds)
  const samplePlayers = competition.competitors?.slice(0, 5) || [];
  samplePlayers.forEach(p => {
    const sc   = p.score && typeof p.score === 'object' ? p.score : {value: p.score, displayValue: String(p.score)};
    const ls   = (p.linescores || []).map(l => `${l.displayValue ?? l.value}`).join(', ');
    const sts  = (p.statistics || []).map(s => `${s.name}=${s.displayValue ?? s.value}`).join(' | ');
    console.log(`  ${p.athlete?.displayName}: score.value=${sc.value} score.display="${sc.displayValue}" state=${p.status?.type?.state} thru=${p.status?.thru} startHole=${p.status?.startHole} detail="${p.status?.type?.detail}" shortDetail="${p.status?.type?.shortDetail}"`);
    if (p.status?.type?.state === 'pre') console.log(`    FULL STATUS: ${JSON.stringify(p.status)}`);
    console.log(`    linescores=[${ls}]  stats=[${sts || 'none'}]`);
  });

  // Parse every competitor
  const golfers = (competition.competitors || []).map(c => {
    const name = c.athlete?.displayName || c.displayName || 'Unknown';

    const statusType  = c.status?.type?.name    || '';
    const detail      = c.status?.type?.detail  || '';
    const startHole   = c.status?.startHole     || 1;
    const playerState = c.status?.type?.state   || 'pre'; // 'pre' | 'in' | 'post'

    // thru can come back as an object in some API versions
    let thruRaw = c.status?.thru;
    if (thruRaw !== null && thruRaw !== undefined && typeof thruRaw === 'object') {
      thruRaw = thruRaw.displayValue ?? thruRaw.value ?? null;
    }
    if (thruRaw === 'F' || thruRaw === 'f') thruRaw = 18;
    else if (typeof thruRaw === 'string')   thruRaw = parseInt(thruRaw, 10) || null;

    // ── Score calculation ─────────────────────────────────────────────────────
    // Primary source: ESPN's `scoreToPar` statistic — their official running
    // total to-par, correct for all states (pre, between rounds, post).
    // Fallback for in-progress rounds: scoreToPar shows "-" mid-round, so we
    // compute: linescores (completed rounds, already to-par) + current round
    // strokes converted via Augusta par.

    const toParStat  = (c.statistics || []).find(s => s.name === 'scoreToPar');
    const toParStr   = (toParStat?.displayValue || '').trim();
    const toParValid = toParStr && toParStr !== '-' && toParStr !== '--';

    const rounds = (c.linescores || []).map(ls => parseScore(ls.displayValue ?? ls.value));
    const completedToPar = rounds.reduce((sum, r) => sum + r, 0);

    // Raw strokes for the current round (only valid when playerState === 'in')
    const rawStrokes = (c.score && typeof c.score === 'object' && typeof c.score.value === 'number')
      ? c.score.value
      : null;

    let scoreValue;
    if (toParValid) {
      // Best case: ESPN gives us the total to-par directly
      scoreValue = parseScore(toParStr);
    } else if (playerState === 'in' && rawStrokes !== null && typeof thruRaw === 'number' && thruRaw > 0) {
      // Mid-round: completed rounds (linescores) + current partial round via Augusta par
      scoreValue = completedToPar + rawStrokes - cumulativePar(thruRaw, startHole);
    } else {
      // Pre-round / hasn't started: linescores total (0 if no rounds played yet)
      scoreValue = completedToPar;
    }

    let status = 'active';
    if (statusType.includes('CUT'))                                                    status = 'cut';
    else if (statusType.includes('WD') || statusType.includes('WITHDRAW'))             status = 'wd';
    else if (statusType.includes('DQ'))                                                status = 'dq';
    else if (statusType.includes('COMPLETE') || detail === 'F' || thruRaw === 18)     status = 'complete';

    // Tee time: shown in detail for players who haven't started their round
    // e.g. "10:05 AM ET" → strip timezone for display
    const teeTime = (playerState === 'pre' && (!thruRaw || thruRaw === 0) && detail && detail !== 'F')
      ? detail.replace(/\s*[A-Z]{2,3}T\s*$/i, '').trim()  // strip trailing timezone (ET, CT, MT, PT, EST, etc.)
      : null;

    return {
      name,
      score:    scoreValue,
      thru:     thruRaw ?? null,
      teeTime,
      status,
      position: c.status?.position?.displayText || '',
      rounds,
    };
  });

  console.log(`Parsed ${golfers.length} golfers`);

  // Compute cut penalty: worst score among those who made/making cut + 10
  const activePlayers = golfers.filter(g => g.status === 'active' || g.status === 'complete');
  const worstActiveScore = activePlayers.length > 0
    ? Math.max(...activePlayers.map(g => g.score))
    : null;
  const cutPenalty = worstActiveScore !== null ? worstActiveScore + 10 : null;

  // Projected cut: score at approximately 50th position among active/complete players
  // (Masters cuts to top 50 + ties after round 2)
  const sortedActive = [...activePlayers].sort((a, b) => a.score - b.score);
  const cutIndex = Math.min(49, sortedActive.length - 1);
  const projectedCut = sortedActive.length >= 10 ? sortedActive[cutIndex].score : null;

  const output = {
    lastUpdated:      new Date().toISOString(),
    tournament:       event.name,
    round,
    roundDetail:      statusDesc,
    tournamentStatus,
    worstActiveScore,
    cutPenalty,
    projectedCut,
    golfers,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`✓ Saved to ${OUT_PATH}`);
  console.log(`  Cut penalty: ${cutPenalty !== null ? formatScore(cutPenalty) : 'N/A'}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function parseScore(raw) {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).trim().toUpperCase();
  if (s === 'E' || s === 'EVEN' || s === '--') return 0;
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function formatScore(n) {
  if (n === 0)  return 'E';
  if (n > 0)    return `+${n}`;
  return String(n);
}

// ── run ───────────────────────────────────────────────────────────────────────
fetchScores().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
