// archetypes.js — shared "playstyle" tagging engine for the Lock in H3 leaderboard.
//
// Nothing here is stored anywhere. Every tag is recalculated live from whatever
// /leaderboard currently returns, purely by ranking a player's per-series rates
// against everyone else in the same mode who's played enough series to be a fair
// comparison (same 5-series minimum used everywhere else on the site). That means
// tags can shift over time — not just because a player's own numbers changed, but
// because the pool around them did. A player can also hold more than one tag at
// once (e.g. Two-Way Star AND Closer), or none yet if they haven't played enough.
//
// Loaded via <script src="archetypes.js"></script> on leaderboard.html and
// player.html — everything here is just plain globals, no build step or exports.

const ARCHETYPE_MIN_SERIES = 5;      // same MIN_SERIES bar used for leaderboard sorting
const ARCHETYPE_OBJ_MIN_SAMPLE = 3;  // same OBJ_MIN_SAMPLE bar used for Caps/S, Hill/S, Ball/S

const ARCHETYPE_DEFS = {
  twoWay:      { name: 'Two-Way Star',   emoji: '🏅', color: 'purple', desc: 'Elite at both slaying and the objective — no real hole in their game.' },
  slayer:      { name: 'Slayer',         emoji: '⭐', color: 'gold',   desc: 'Racks up frags well above the pool average; objective time takes a backseat.' },
  objSpec:     { name: 'OBJ Specialist', emoji: '🎯', color: 'green',  desc: 'Wins games on the objective — caps, hill time, or ball time stand out.' },
  playmaker:   { name: 'Playmaker',      emoji: '🤝', color: 'blue',   desc: 'Sets teammates up more than they finish plays themselves.' },
  glassCannon: { name: 'Glass Cannon',   emoji: '💥', color: 'orange', desc: 'Feast or famine — gets frags in bunches, but dies plenty doing it.' },
  fortress:    { name: 'Fortress',       emoji: '🛡️', color: 'teal',   desc: 'Rarely dies — the steady, hard-to-kill piece of the squad.' },
  closer:      { name: 'Closer',         emoji: '🏆', color: 'green',  desc: 'Just gets it done — their win rate outpaces what their raw numbers suggest.' },
  anchor:      { name: 'Anchor',         emoji: '⚓', color: 'red',    desc: 'Currently trending below the pool on most stats — plenty of room to climb.' },
  wildcard:    { name: 'Wildcard',       emoji: '🎲', color: 'muted',  desc: "No standout trait yet — a jack-of-all-trades, or just needs more series to read." }
};

// Percentile of `value` within `pool` (plain array of numbers). 0 = tied-lowest in the
// pool, 1 = tied-highest. Ties split the difference so nobody's inflated by duplicates.
function _archPercentile(pool, value) {
  if (!pool.length) return 0.5;
  let below = 0, equal = 0;
  pool.forEach(v => { if (v < value) below++; else if (v === value) equal++; });
  return (below + equal * 0.5) / pool.length;
}

// Converts raw leaderboard player objects into the per-series rates archetypes are
// judged on. Only players past the series minimum are included — same fairness bar
// used for every other rate-based column on the leaderboard.
function _archBuildPool(players) {
  return players
    .filter(p => (p.seriesPlayed || 0) >= ARCHETYPE_MIN_SERIES)
    .map(p => {
      const played = p.seriesPlayed || 1;
      const deaths = p.deaths || 0;
      const kills = p.kills || 0;
      return {
        ref: p,
        killsPS: kills / played,
        assistsPS: (p.assists || 0) / played,
        deathsPS: deaths / played,
        kdRatio: deaths > 0 ? kills / deaths : kills,
        winPct: (p.seriesWon || 0) / played,
        capsRate: (p.capsSeriesCount || 0) >= ARCHETYPE_OBJ_MIN_SAMPLE ? (p.flagCaps || 0) / p.capsSeriesCount : null,
        hillRate: (p.hillSeriesCount || 0) >= ARCHETYPE_OBJ_MIN_SAMPLE ? (p.hillSecs || 0) / p.hillSeriesCount : null,
        ballRate: (p.ballSeriesCount || 0) >= ARCHETYPE_OBJ_MIN_SAMPLE ? (p.ballSecs || 0) / p.ballSeriesCount : null
      };
    });
}

// Returns { tags: [...defKeys], compositeSkill, percentiles: {...} } for this player
// within this pool, or null if there isn't enough data yet (either this player hasn't
// hit the series minimum, or the pool itself is too small to rank fairly against).
// `allPlayersInMode` and `player` should be plain objects from the same /leaderboard
// response shape (an array of the values, or one entry from it).
function getPlayerArchetypes(allPlayersInMode, player) {
  if (!player || (player.seriesPlayed || 0) < ARCHETYPE_MIN_SERIES) return null;
  const poolRows = _archBuildPool(allPlayersInMode);
  if (poolRows.length < 4) return null;

  const selfRow = poolRows.find(r => r.ref === player) ||
    poolRows.find(r => (r.ref.displayName || '').toLowerCase() === (player.displayName || '').toLowerCase());
  if (!selfRow) return null;

  const pctOf = (key) => _archPercentile(poolRows.map(r => r[key]), selfRow[key]);

  const pKills = pctOf('killsPS');
  const pAssists = pctOf('assistsPS');
  const pDeaths = pctOf('deathsPS');   // higher = dies MORE than most
  const pSurvival = 1 - pDeaths;       // higher = dies LESS than most
  const pKD = pctOf('kdRatio');
  const pWin = pctOf('winPct');
  const pSlay = pKD * 0.6 + pKills * 0.4;

  // OBJ percentile only ranks a player against others who actually have that specific
  // gametype logged — someone who's never played CTF shouldn't be penalized for a "0".
  // Takes the BEST of their available category percentiles rather than averaging them:
  // not everyone gets equal exposure to CTF/KOTH/Oddball (map rotation varies who plays
  // what), so a player who's excellent at Hill but only average at Caps should still
  // read as a strong OBJ contributor — one weak category shouldn't cancel out a strong one.
  const objParts = [];
  ['capsRate', 'hillRate', 'ballRate'].forEach(key => {
    if (selfRow[key] == null) return;
    const subPool = poolRows.filter(r => r[key] != null).map(r => r[key]);
    if (subPool.length < 4) return; // not enough of the pool has this gametype logged to rank fairly
    objParts.push(_archPercentile(subPool, selfRow[key]));
  });
  const objAvailable = objParts.length > 0;
  const pObj = objAvailable ? Math.max(...objParts) : null;

  const skillParts = [pSlay, pAssists, pSurvival];
  if (objAvailable) skillParts.push(pObj);
  const compositeSkill = skillParts.reduce((s, v) => s + v, 0) / skillParts.length;

  // These cutoffs were tuned against a simulated 30-player pool rather than picked
  // blindly — the original values (0.70 / 0.20) left ~30% of players as Wildcard and
  // only flagged the single most extreme case as Anchor, since ANDing two 0.70+
  // percentile bars together (or averaging 3-4 percentiles for Anchor) is a much
  // higher bar than it looks. These values land closer to ~18% Wildcard and a more
  // representative slice of Anchors. All still just named constants — retune freely
  // if the mix still feels off against real data.
  const HIGH = 0.65, LOW_OBJ = 0.50, GAP = 0.12, GLASS_T = 0.60,
        FORTRESS_SURV = 0.75, FORTRESS_MIN_KILLS = 0.32, CLOSER_GAP = 0.15, ANCHOR_T = 0.25;

  const tags = [];
  const isTwoWay = pSlay >= HIGH && objAvailable && pObj >= HIGH;
  if (isTwoWay) tags.push('twoWay');
  if (!isTwoWay && pSlay >= HIGH && (!objAvailable || pObj < LOW_OBJ)) tags.push('slayer');
  if (!isTwoWay && objAvailable && pObj >= HIGH && pSlay < LOW_OBJ) tags.push('objSpec');
  if (pAssists >= HIGH && (pAssists - pSlay) >= GAP) tags.push('playmaker');
  if (pKills >= GLASS_T && pDeaths >= GLASS_T) tags.push('glassCannon');
  if (pSurvival >= FORTRESS_SURV && pKills >= FORTRESS_MIN_KILLS) tags.push('fortress');
  if ((pWin - compositeSkill) >= CLOSER_GAP) tags.push('closer');
  if (compositeSkill <= ANCHOR_T) tags.push('anchor');
  if (tags.length === 0) tags.push('wildcard');

  return {
    tags,
    compositeSkill,
    percentiles: { pKills, pAssists, pDeaths, pSurvival, pKD, pWin, pSlay, pObj }
  };
}

// Order to show tags in when space is limited (leaderboard row) — leads with the
// more distinctive/flattering tags, since a player's full set still shows on their
// profile page regardless of what gets cut here.
const ARCHETYPE_ROW_PRIORITY = ['twoWay', 'closer', 'objSpec', 'slayer', 'playmaker', 'glassCannon', 'fortress', 'anchor', 'wildcard'];

function archetypeBadgeHtml(key, extraClass) {
  const d = ARCHETYPE_DEFS[key];
  if (!d) return '';
  const safeDesc = d.desc.replace(/"/g, '&quot;');
  return `<span class="arch-badge arch-${d.color}${extraClass ? ' ' + extraClass : ''}" title="${d.name} — ${safeDesc}">${d.emoji} ${d.name}</span>`;
}

// A compact "what these mean" glossary, reused by both pages so the wording never
// drifts out of sync between them.
function archetypeLegendHtml() {
  return Object.keys(ARCHETYPE_DEFS).map(key => {
    const d = ARCHETYPE_DEFS[key];
    return `<div class="arch-legend-row"><span class="arch-badge arch-${d.color}">${d.emoji} ${d.name}</span><span class="arch-legend-desc">${d.desc}</span></div>`;
  }).join('');
}

// Turns the raw percentiles from getPlayerArchetypes() into a couple of plain-language
// strength / potential-focus-area lines for a player's bio. Only calls out a category
// when it's clearly above or below the pack — otherwise it's left out rather than
// forcing a weak signal into a strength or weakness.
const ARCHETYPE_STAT_LABELS = { pSlay: 'Slaying', pAssists: 'Playmaking', pObj: 'Objective Play', pSurvival: 'Survivability', pWin: 'Winning' };
function getStrengthsAndWeaknesses(percentiles) {
  const entries = Object.keys(ARCHETYPE_STAT_LABELS)
    .filter(key => percentiles[key] != null)
    .map(key => ({ label: ARCHETYPE_STAT_LABELS[key], value: percentiles[key] }));
  const strengths = entries.filter(e => e.value >= 0.65).sort((a, b) => b.value - a.value).map(e => e.label);
  const weaknesses = entries.filter(e => e.value <= 0.35).sort((a, b) => a.value - b.value).map(e => e.label);
  return { strengths, weaknesses };
}
