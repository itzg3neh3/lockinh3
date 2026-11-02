// Player insights built from the series History: current win/loss streaks (On Fire /
// Ice Cold) and teammate/opponent relationships (Ride or Die / Nemesis). Everything
// here is a pure function of the /history entries, so it works the same on the
// leaderboard and on player pages, and nothing about the stored data changes.

const PI_STREAK_MIN = 4;            // series in a row needed for On Fire / Ice Cold
const PI_STREAK_MAX_AGE_DAYS = 30;  // streak only counts as "current" if last series is this recent
const PI_REL_MIN_SERIES = 5;        // series together / against before a pairing is considered
const PI_RIDE_MIN_WINPCT = 0.55;    // Ride or Die must actually be a winning pairing
const PI_NEMESIS_MAX_WINPCT = 0.45; // Nemesis must actually be a losing matchup

function piNorm(n) { return (n || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Same eligibility the leaderboard uses: skip removed series, ties, and entries whose
// squad sizes don't match the mode label (e.g. 2-player squads saved into the 4v4 pool).
function piEligible(entries, mode) {
  const size = mode === '1v1' ? 1 : mode === '2v2' ? 2 : 4;
  return (entries || [])
    .filter(e => e && !e.removedFromLeaderboard && e.mode === mode &&
      (e.squad1 || []).length === size && (e.squad2 || []).length === size &&
      (e.seriesWinner === 1 || e.seriesWinner === 2))
    .slice()
    .sort((a, b) => String(a.playedAt).localeCompare(String(b.playedAt)));
}

// -> { normName: { type: 'win'|'loss', count, lastAt (ms) } }
function piStreaks(entries, mode) {
  const results = {};
  piEligible(entries, mode).forEach(e => {
    const t = Date.parse(e.playedAt) || 0;
    [[1, e.squad1], [2, e.squad2]].forEach(([sq, names]) => {
      names.forEach(n => {
        const k = piNorm(n);
        if (!k) return;
        (results[k] = results[k] || []).push({ won: e.seriesWinner === sq, t });
      });
    });
  });
  const out = {};
  Object.keys(results).forEach(k => {
    const list = results[k];
    const last = list[list.length - 1];
    let count = 0;
    for (let i = list.length - 1; i >= 0 && list[i].won === last.won; i--) count++;
    out[k] = { type: last.won ? 'win' : 'loss', count, lastAt: last.t };
  });
  return out;
}

// Returns { type, count } when this player has an active streak worth a badge, else null.
function piStreakFor(streakMap, name, nowMs) {
  const s = streakMap && streakMap[piNorm(name)];
  if (!s || s.count < PI_STREAK_MIN) return null;
  const ageDays = ((nowMs || Date.now()) - s.lastAt) / 86400000;
  if (ageDays > PI_STREAK_MAX_AGE_DAYS) return null;
  return { type: s.type, count: s.count };
}

// -> { rideOrDie: {name, wins, losses, n} | null, nemesis: {name, wins, losses, n} | null }
// For Nemesis, wins/losses are THIS player's record against that opponent.
function piRelations(entries, mode, playerName) {
  const me = piNorm(playerName);
  const mates = {}, foes = {}, display = {};
  piEligible(entries, mode).forEach(e => {
    let mySq = 0;
    if ((e.squad1 || []).some(n => piNorm(n) === me)) mySq = 1;
    else if ((e.squad2 || []).some(n => piNorm(n) === me)) mySq = 2;
    if (!mySq) return;
    const won = e.seriesWinner === mySq;
    const mine = mySq === 1 ? e.squad1 : e.squad2, theirs = mySq === 1 ? e.squad2 : e.squad1;
    const tally = (names, bucket, skipMe) => names.forEach(n => {
      const k = piNorm(n);
      if (!k || (skipMe && k === me)) return;
      display[k] = n;
      const r = bucket[k] = bucket[k] || { wins: 0, losses: 0 };
      if (won) r.wins++; else r.losses++;
    });
    tally(mine, mates, true);
    tally(theirs, foes, false);
  });
  const rows = (bucket) => Object.keys(bucket)
    .map(k => ({ name: display[k], wins: bucket[k].wins, losses: bucket[k].losses, n: bucket[k].wins + bucket[k].losses }))
    .filter(r => r.n >= PI_REL_MIN_SERIES);
  const ride = rows(mates)
    .filter(r => r.wins / r.n >= PI_RIDE_MIN_WINPCT)
    .sort((a, b) => (b.wins / b.n) - (a.wins / a.n) || b.n - a.n)[0] || null;
  const nem = rows(foes)
    .filter(r => r.wins / r.n <= PI_NEMESIS_MAX_WINPCT)
    .sort((a, b) => (a.wins / a.n) - (b.wins / b.n) || b.n - a.n)[0] || null;
  return { rideOrDie: ride, nemesis: nem };
}
