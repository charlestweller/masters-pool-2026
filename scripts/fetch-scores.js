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

  // Log a few players so scores are visible in Actions logs
  const samplePlayers = competition.competitors?.slice(0, 3) || [];
  samplePlayers.forEach(p => {
    const sc = p.score?.value ?? p.score;
    console.log(`  ${p.athlete?.displayName}: score.value=${sc}, thru=${p.status?.thru}`);
  });

  // Parse every competitor
  const golfers = (competition.competitors || []).map(c => {
    const name = c.athlete?.displayName || c.displayName || 'Unknown';

    // ── Score to par ──────────────────────────────────────────────────────────
    // ESPN returns score as an object: { value: -5, displayValue: "-5" }
    // displayValue is "-" (a dash) when no score yet — must use .value (the number).
    let scoreValue;
    if (c.score !== null && c.score !== undefined) {
      if (typeof c.score === 'object') {
        // Use numeric .value directly; it's 0 for even/not-started, -5 for 5 under, etc.
        scoreValue = typeof c.score.value === 'number' ? c.score.value : parseScore(c.score.displayValue);
      } else {
        scoreValue = parseScore(c.score);
      }
    } else {
      scoreValue = 0;
    }

    const statusType = c.status?.type?.name || '';
    const detail     = c.status?.type?.detail || '';

    // thru can also come back as an object in some API versions
    let thruRaw = c.status?.thru;
    if (thruRaw !== null && thruRaw !== undefined && typeof thruRaw === 'object') {
      thruRaw = thruRaw.displayValue ?? thruRaw.value ?? null;
    }
    // Convert string "18" or "F" to appropriate types
    if (thruRaw === 'F' || thruRaw === 'f') thruRaw = 18;
    else if (typeof thruRaw === 'string') thruRaw = parseInt(thruRaw, 10) || null;

    let status = 'active';
    if (statusType.includes('CUT'))                          status = 'cut';
    else if (statusType.includes('WD') || statusType.includes('WITHDRAW')) status = 'wd';
    else if (statusType.includes('DQ'))                      status = 'dq';
    else if (statusType.includes('COMPLETE') || detail === 'F' || thruRaw === 18) status = 'complete';

    // Round-by-round scores
    const rounds = (c.linescores || []).map(ls => parseScore(ls.displayValue ?? ls.value));

    return {
      name,
      score:    scoreValue,
      thru:     thruRaw ?? null,
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
