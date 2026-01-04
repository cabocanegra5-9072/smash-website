const express = require("express");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json());

app.get("/admin.html", (req, res) => {
  if (!requireAdmin(req)) return res.status(401).send("Unauthorized");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/__which-server", (req, res) => {
  res.json({ runningServerFile: __filename, dirname: __dirname });
});

app.get("/debug-paths", (req, res) => {
  const rootDataDir = path.join(__dirname, "..", "data");
  const backendDataDir = path.join(__dirname, "data");

  res.json({
    runningServerFile: __filename,
    rootPlayers: path.join(rootDataDir, "players.json"),
    rootPlayersExists: fs.existsSync(path.join(rootDataDir, "players.json")),
    rootTournaments: path.join(rootDataDir, "tournaments.json"),
    rootTournamentsExists: fs.existsSync(path.join(rootDataDir, "tournaments.json")),
    backendPlayers: path.join(backendDataDir, "players.json"),
    backendPlayersExists: fs.existsSync(path.join(backendDataDir, "players.json")),
    backendTournaments: path.join(backendDataDir, "tournaments.json"),
    backendTournamentsExists: fs.existsSync(path.join(backendDataDir, "tournaments.json")),
  });
});

console.log("RUNNING SERVER FILE:", __filename);
console.log("✅ server.js started");
console.log("PORT from .env =", process.env.PORT);
console.log("Has STARTGG_TOKEN =", Boolean(process.env.STARTGG_TOKEN));

const STARTGG_ENDPOINT = "https://api.start.gg/gql/alpha";

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

async function startggQuery(query, variables) {
  const res = await fetch(STARTGG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.STARTGG_TOKEN}`
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json();

  if (!res.ok || json.errors) {
    throw new Error(
      JSON.stringify({ status: res.status, errors: json.errors, json }, null, 2)
    );
  }

  return json.data;
}

const GET_EVENT = `
  query GetEvent($slug: String!) {
    event(slug: $slug) { id name }
  }
`;

const GET_EVENT_WITH_TOURNAMENT = `
  query GetEventWithTournament($slug: String!) {
    event(slug: $slug) {
      id
      name
      tournament {
        id
        name
      }
    }
  }
`;

const GET_STANDINGS = `
  query EventStandings($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      id
      name
      standings(query: { page: $page, perPage: $perPage }) {
        nodes {
          placement
          entrant {
            id
            name
            participants {
              id
              gamerTag
              player {
                id
                gamerTag
              }
            }
          }
        }
      }
    }
  }
`;

app.get("/import-standings", async (req, res) => {
  try {
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: "Missing ?slug=" });

    const eventData = await startggQuery(GET_EVENT, { slug });
    const eventId = eventData.event.id;

    const nodes = await fetchAllStandings(eventId);

    res.json(eventData);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/export-playerids", async (req, res) => {
  try {
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: "Missing ?slug=" });

    const eventData = await startggQuery(GET_EVENT, { slug });
    const eventId = eventData.event.id;

    const nodes = await fetchAllStandings(eventId);

    const exported = nodes.map((n) => {
      const entrant = n.entrant;
      const firstParticipant = entrant?.participants?.[0];
      const player = firstParticipant?.player;

      return {
        placement: n.placement,
        startggPlayerId: player?.id ?? null,
        gamerTag: player?.gamerTag ?? firstParticipant?.gamerTag ?? null,
        entrantName: entrant?.name ?? null,
        entrantId: entrant?.id ?? null
      };
    });

    const missing = exported.filter((x) => x.startggPlayerId === null).length;

    res.json({
      slug,
      eventId,
      eventName: eventData.event.name,
      count: exported.length,
      missingStartggPlayerIds: missing,
      exported
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function loadPlayersFile() {
  const playersPath = path.join(DATA_DIR, "players.json");

  // ✅ Don't crash the whole site if file is missing in production
  if (!fs.existsSync(playersPath)) return [];

  const raw = fs.readFileSync(playersPath, "utf-8").trim();
  if (!raw) return [];

  return JSON.parse(raw);
}

app.get("/make-results", async (req, res) => {
  try {
    const slug = req.query.slug;
    const tournamentId = req.query.tournamentId;
    if (!slug) return res.status(400).json({ error: "Missing ?slug=" });
    if (!tournamentId) return res.status(400).json({ error: "Missing ?tournamentId=" });

    const eventData = await startggQuery(GET_EVENT, { slug });
    const eventId = eventData.event.id;

    const nodes = await fetchAllStandings(eventId);

    const players = loadPlayersFile();
    const lookup = new Map();
    for (const p of players) {
      const sid = p?.startgg?.playerId;
      if (sid != null) lookup.set(Number(sid), p.playerId);
    }

    const results = [];
    const unmapped = [];

    for (const n of nodes) {
      const entrant = n.entrant;
      const firstParticipant = entrant?.participants?.[0];
      const player = firstParticipant?.player;

      const startggPlayerId = player?.id ?? null;
      const gamerTag = player?.gamerTag ?? firstParticipant?.gamerTag ?? entrant?.name ?? null;

      const mappedPlayerId =
        startggPlayerId != null ? lookup.get(Number(startggPlayerId)) : null;

      if (mappedPlayerId) {
        results.push({
          playerId: mappedPlayerId,
          tournamentId,
          placement: n.placement
        });
      } else {
        unmapped.push({
          startggPlayerId,
          gamerTag,
          entrantName: entrant?.name ?? null,
          placement: n.placement
        });
      }
    }

    res.json({
      slug,
      tournamentId,
      eventId,
      eventName: eventData.event.name,
      mappedCount: results.length,
      unmappedCount: unmapped.length,
      results,
      unmapped
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function loadJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${filePath} must be a JSON array`);
  return parsed;
}

function writeJsonPretty(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

app.get("/append-results", async (req, res) => {
  try {
    const slug = req.query.slug;
    const tournamentId = req.query.tournamentId;
    if (!slug) return res.status(400).json({ error: "Missing ?slug=" });
    if (!tournamentId) return res.status(400).json({ error: "Missing ?tournamentId=" });

    // Reuse the same logic as /make-results
    const eventData = await startggQuery(GET_EVENT, { slug });
    const eventId = eventData.event.id;

    const nodes = await fetchAllStandings(eventId);

    // Load mapping from players.json
    const playersPath = path.join(DATA_DIR, "players.json");
    const players = JSON.parse(fs.readFileSync(playersPath, "utf-8"));
    const lookup = new Map();
    for (const p of players) {
      const sid = p?.startgg?.playerId;
      if (sid != null) lookup.set(Number(sid), p.playerId);
    }

    // Build mapped results
    const mapped = [];
    const unmapped = [];

    for (const n of nodes) {
      const entrant = n.entrant;
      const firstParticipant = entrant?.participants?.[0];
      const player = firstParticipant?.player;

      const startggPlayerId = player?.id ?? null;
      const gamerTag = player?.gamerTag ?? firstParticipant?.gamerTag ?? entrant?.name ?? null;

      const mappedPlayerId =
        startggPlayerId != null ? lookup.get(Number(startggPlayerId)) : null;

      if (mappedPlayerId) {
        mapped.push({
          playerId: mappedPlayerId,
          tournamentId,
          placement: n.placement
        });
      } else {
        unmapped.push({
          startggPlayerId,
          gamerTag,
          entrantName: entrant?.name ?? null,
          placement: n.placement
        });
      }
    }

    // Append into results.json (dedupe by playerId+tournamentId)
    const resultsPath = path.join(DATA_DIR, "results.json");
    const existing = loadJsonArray(resultsPath);

    const key = (r) => `${r.playerId}__${r.tournamentId}`;
    const existingKeys = new Set(existing.map(key));

    let appended = 0;
    for (const r of mapped) {
      if (!existingKeys.has(key(r))) {
        existing.push(r);
        existingKeys.add(key(r));
        appended++;
      }
    }

    writeJsonPretty(resultsPath, existing);

    res.json({
      ok: true,
      tournamentId,
      slug,
      appended,
      mappedCount: mapped.length,
      unmappedCount: unmapped.length,
      note: "Mapped results were appended to data/results.json (deduped by playerId+tournamentId)."
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/unmapped", async (req, res) => {
  try {
    const slug = req.query.slug;
    const tournamentId = req.query.tournamentId;
    if (!slug) return res.status(400).json({ error: "Missing ?slug=" });
    if (!tournamentId) return res.status(400).json({ error: "Missing ?tournamentId=" });

    // Just reuse /make-results logic by calling it internally (copy minimal)
    const eventData = await startggQuery(GET_EVENT, { slug });
    const eventId = eventData.event.id;

    const nodes = await fetchAllStandings(eventId);

    const playersPath = path.join(DATA_DIR, "players.json");
    const players = JSON.parse(fs.readFileSync(playersPath, "utf-8"));

    const lookup = new Map();
    for (const p of players) {
      const sid = p?.startgg?.playerId;
      if (sid != null) lookup.set(Number(sid), p.playerId);
    }

    const unmapped = [];
    for (const n of nodes) {
      const entrant = n.entrant;
      const firstParticipant = entrant?.participants?.[0];
      const player = firstParticipant?.player;

      const startggPlayerId = player?.id ?? null;
      const gamerTag = player?.gamerTag ?? firstParticipant?.gamerTag ?? entrant?.name ?? null;

      const mappedPlayerId =
        startggPlayerId != null ? lookup.get(Number(startggPlayerId)) : null;

      if (!mappedPlayerId) {
        unmapped.push({
          placement: n.placement,
          startggPlayerId,
          gamerTag,
          entrantName: entrant?.name ?? null
        });
      }
    }

    res.json({ slug, tournamentId, unmappedCount: unmapped.length, unmapped });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/add-player", (req, res) => {
  try {
    const { startggPlayerId, tag, region } = req.body || {};
    if (!startggPlayerId) return res.status(400).json({ error: "Missing startggPlayerId" });
    if (!tag) return res.status(400).json({ error: "Missing tag" });

    const playersPath = path.join(DATA_DIR, "players.json");
    const players = JSON.parse(fs.readFileSync(playersPath, "utf-8"));

    // Prevent duplicates
    const sidNum = Number(startggPlayerId);
    const already = players.find((p) => Number(p?.startgg?.playerId) === sidNum);
    if (already) {
      return res.json({ ok: true, message: "Already exists", playerId: already.playerId });
    }

    // Create your internal ID: p_<lowercase alnum>
    const safe = tag.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    let newPlayerId = `p_${safe || "player"}`;

    // Ensure unique internal id
    const used = new Set(players.map((p) => p.playerId));
    let k = 2;
    while (used.has(newPlayerId)) {
      newPlayerId = `p_${safe || "player"}_${k}`;
      k++;
    }

    const newPlayer = {
      playerId: newPlayerId,
      tag: tag,
      region: region || "",
      startgg: { playerId: sidNum }
    };

    players.push(newPlayer);
    fs.writeFileSync(playersPath, JSON.stringify(players, null, 2), "utf-8");

    res.json({ ok: true, added: newPlayer });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/mapper", (req, res) => {
  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Player Mapper</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 16px; }
    input { width: 520px; padding: 6px; margin: 4px 0; }
    button { padding: 6px 10px; margin-left: 6px; }
    table { border-collapse: collapse; margin-top: 12px; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 6px; text-align: left; }
    th { background: #f5f5f5; }
    .small { color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <h2>Player Mapper</h2>
  <div class="small">Goal: take unmapped start.gg Player IDs and add them into data/players.json</div>

  <div>
    <div>Slug</div>
    <input id="slug" value="tournament/genesis-x2/event/ultimate-singles"/>
  </div>
  <div>
    <div>Tournament ID</div>
    <input id="tournamentId" value="t_genesis_x2_2025"/>
  </div>

  <button onclick="loadUnmapped()">Load Unmapped</button>
  <button onclick="autoAddAll()">Auto Add All</button>

  <div id="status" style="margin-top:10px;"></div>

  <table id="tbl" style="display:none;">
    <thead>
      <tr>
        <th>Placement</th>
        <th>GamerTag</th>
        <th>startggPlayerId</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody id="body"></tbody>
  </table>

<script>
async function loadUnmapped() {
  const slug = document.getElementById('slug').value.trim();
  const tournamentId = document.getElementById('tournamentId').value.trim();
  const status = document.getElementById('status');
  const tbl = document.getElementById('tbl');
  const body = document.getElementById('body');

  status.textContent = "Loading...";
  body.innerHTML = "";
  tbl.style.display = "none";

  const res = await fetch(\`/unmapped?slug=\${encodeURIComponent(slug)}&tournamentId=\${encodeURIComponent(tournamentId)}\`);
  const data = await res.json();
  if (!res.ok) {
    status.textContent = "Error: " + (data.error || res.status);
    return;
  }

  status.textContent = \`Unmapped: \${data.unmappedCount}\`;
  tbl.style.display = "";

  for (const p of data.unmapped) {
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td>\${p.placement}</td>
      <td>\${p.gamerTag || p.entrantName || ""}</td>
      <td>\${p.startggPlayerId}</td>
      <td><button class="add-btn" data-id="\${p.startggPlayerId}" data-tag="\${(p.gamerTag || "").replace(/"/g,'&quot;')}" onclick="addPlayer(this)">Add</button></td>
    \`;
    body.appendChild(tr);
  }
}

async function addPlayer(btn) {
  const sid = Number(btn.getAttribute('data-id'));
  const tag = btn.getAttribute('data-tag') || ("player_" + sid);

  const region = ""; // always blank, no prompts

  btn.disabled = true;
  btn.textContent = "Adding...";

  const res = await fetch("/add-player", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startggPlayerId: sid, tag, region })
  });

  const data = await res.json();
  if (!res.ok) {
    btn.disabled = false;
    btn.textContent = "Add";
    alert("Error: " + (data.error || res.status));
    return;
  }

  btn.textContent = "Added ✅";
}

async function autoAddAll() {
  const status = document.getElementById('status');
  const buttons = Array.from(document.querySelectorAll('#body button.add-btn'));

  if (buttons.length === 0) {
    alert("Load Unmapped first.");
    return;
  }

const ok = confirm("Auto-add " + buttons.length + " players to players.json?");
  if (!ok) return;

  let added = 0;
  let failed = 0;

status.textContent = "Auto-adding " + buttons.length + " players...";

  // Add sequentially to avoid hammering your backend
  for (const btn of buttons) {
    try {
      // skip if already added
      if (btn.disabled || btn.textContent.includes("✅")) continue;

      await addPlayer(btn);
      added++;
    } catch (e) {
      failed++;
    }
  }

status.textContent = "Done. Added " + added + ", failed " + failed + ".";
}

</script>
</body>
</html>
  `);
});

app.get("/reimport-results", async (req, res) => {
  try {
    const slug = req.query.slug;
    const tournamentId = req.query.tournamentId;
    if (!slug) return res.status(400).json({ error: "Missing ?slug=" });
    if (!tournamentId) return res.status(400).json({ error: "Missing ?tournamentId=" });

    // 1) Remove existing results for that tournamentId
    const resultsPath = path.join(DATA_DIR, "results.json");
    const existing = loadJsonArray(resultsPath);
    const before = existing.length;

    const filtered = existing.filter((r) => r.tournamentId !== tournamentId);
    const removed = before - filtered.length;

    writeJsonPretty(resultsPath, filtered);

    // 2) Now append fresh results by reusing the same logic as /append-results
    // Pull standings
    const eventData = await startggQuery(GET_EVENT, { slug });
    const eventId = eventData.event.id;

    const nodes = await fetchAllStandings(eventId);

    // Load mapping from players.json
    const playersPath = path.join(DATA_DIR, "players.json");
    const players = JSON.parse(fs.readFileSync(playersPath, "utf-8"));
    const lookup = new Map();
    for (const p of players) {
      const sid = p?.startgg?.playerId;
      if (sid != null) lookup.set(Number(sid), p.playerId);
    }

    // Build mapped results
    const mapped = [];
    const unmapped = [];

    for (const n of nodes) {
      const entrant = n.entrant;
      const firstParticipant = entrant?.participants?.[0];
      const player = firstParticipant?.player;

      const startggPlayerId = player?.id ?? null;
      const gamerTag = player?.gamerTag ?? firstParticipant?.gamerTag ?? entrant?.name ?? null;

      const mappedPlayerId =
        startggPlayerId != null ? lookup.get(Number(startggPlayerId)) : null;

      if (mappedPlayerId) {
        mapped.push({
          playerId: mappedPlayerId,
          tournamentId,
          placement: n.placement
        });
      } else {
        unmapped.push({
          startggPlayerId,
          gamerTag,
          entrantName: entrant?.name ?? null,
          placement: n.placement
        });
      }
    }

    // Append into results.json (dedupe by playerId+tournamentId)
    const afterRemoval = loadJsonArray(resultsPath);
    const key = (r) => `${r.playerId}__${r.tournamentId}`;
    const keys = new Set(afterRemoval.map(key));

    let appended = 0;
    for (const r of mapped) {
      if (!keys.has(key(r))) {
        afterRemoval.push(r);
        keys.add(key(r));
        appended++;
      }
    }

    writeJsonPretty(resultsPath, afterRemoval);

    res.json({
      ok: true,
      tournamentId,
      slug,
      removed,
      appended,
      mappedCount: mapped.length,
      unmappedCount: unmapped.length,
      note: "Removed old tournament results and re-imported fresh ones."
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function loadTournamentsFile() {
  const p = path.join(DATA_DIR, "tournaments.json");
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf-8").trim();
  return raw ? JSON.parse(raw) : [];
}

function loadResultsFile() {
  const p = path.join(DATA_DIR, "results.json");
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf-8").trim();
  return raw ? JSON.parse(raw) : [];
}

/**
 * Points model (customizable):
 * 1) Convert placement -> base points
 * 2) Multiply by tier multiplier
 *
 * This is a reasonable starter model. You’ll tweak it as your community decides.
 */
function basePointsForPlacement(placement) {
  // Using common bracket placement buckets (1,2,3,4,5,7,9,13,17,25,33,49,65...)
  const table = new Map([
    [1, 2000],
    [2, 1600],
    [3, 1300],
    [4, 1100],
    [5, 900],
    [7, 750],
    [9, 600],
    [13, 450],
    [17, 325],
    [25, 225],
    [33, 150],
    [49, 90],
    [65, 50]
  ]);

  // Exact match (Genesis gives placements like 49, 33, etc.)
  if (table.has(placement)) return table.get(placement);

  // If some event returns a weird placement number, map it down to the closest lower bucket.
  const buckets = Array.from(table.keys()).sort((a, b) => a - b);
  let best = null;
  for (const b of buckets) {
    if (placement >= b) best = b;
  }
  return best ? table.get(best) : 0;
}

function tierMultiplier(tier) {
  const t = String(tier || "").toUpperCase().trim();

  // Edit these however you want.
  const multipliers = {
    P: 1.0,
    S: 0.85,
    "SUPERMAJOR": 0.85,
    "SUPER MAJOR": 0.85,
    MAJOR: 0.75,
    A: 0.6,
    B: 0.45,
    C: 0.3
  };

  return multipliers[t] ?? 0.5; // default mid-tier
}

let RESULTS_CACHE = [];
let CACHE_STATUS = {
  rebuilding: false,
  lastRebuildAt: null,
  lastError: null,
  tournamentsProcessed: 0,
  resultsCount: 0
};

app.get("/leaderboard", (req, res) => {
  try {
    const season = req.query.season ? Number(req.query.season) : null;

    const players = loadPlayersFile();
    const results = RESULTS_CACHE;
    const tournaments = loadTournamentsFile();

    // Indexes for fast joins
    const playerById = new Map(players.map((p) => [p.playerId, p]));
    const tournamentById = new Map(tournaments.map((t) => [t.tournamentId, t]));

    // Filter results by season (if provided)
    const filteredResults = results.filter((r) => {
      if (!season) return true;
      const t = tournamentById.get(r.tournamentId);
      return t && Number(t.season) === season;
    });

    // Aggregate points per player
    const totals = new Map(); // playerId -> { points, events, bestFinish }
    for (const r of filteredResults) {
      const t = tournamentById.get(r.tournamentId);
      const tier = t?.tier ?? "B";

      const base = basePointsForPlacement(Number(r.placement));
      const pts = Math.round(base * tierMultiplier(tier));

      const cur = totals.get(r.playerId) || { points: 0, events: 0, bestFinish: null };
      cur.points += pts;
      cur.events += 1;
      if (cur.bestFinish == null || Number(r.placement) < cur.bestFinish) cur.bestFinish = Number(r.placement);
      totals.set(r.playerId, cur);
    }

    // Turn into an array and sort
    const rows = Array.from(totals.entries()).map(([playerId, agg]) => {
      const p = playerById.get(playerId);
      return {
        playerId,
        tag: p?.tag ?? playerId,
        region: p?.region ?? "",
        points: agg.points,
        events: agg.events,
        bestFinish: agg.bestFinish
      };
    });

    rows.sort((a, b) => {
      // 1) points desc
      if (b.points !== a.points) return b.points - a.points;
      // 2) best finish asc (1 is better)
      if ((a.bestFinish ?? 9999) !== (b.bestFinish ?? 9999)) return (a.bestFinish ?? 9999) - (b.bestFinish ?? 9999);
      // 3) more events desc
      if (b.events !== a.events) return b.events - a.events;
      // 4) tag alpha
      return a.tag.localeCompare(b.tag);
    });

    // Assign rank
    const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));

    res.json({
      season: season || "all",
      tournamentsKnown: tournaments.length,
      resultsUsed: filteredResults.length,
      playersKnown: players.length,
      leaderboard: ranked
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/debug-data", (req, res) => {
  try {
    const results = loadResultsFile();
    const tournaments = loadTournamentsFile();

    const resultTournamentIds = Array.from(
      new Set(results.map((r) => r.tournamentId))
    ).sort();

    const tournamentsSummary = tournaments.map((t) => ({
      tournamentId: t.tournamentId,
      season: t.season,
      tier: t.tier,
      name: t.name
    }));

    // Count how many results belong to each tournamentId
    const counts = {};
    for (const r of results) {
      counts[r.tournamentId] = (counts[r.tournamentId] || 0) + 1;
    }

    res.json({
      resultsCount: results.length,
      resultTournamentIds,
      tournamentsKnown: tournamentsSummary,
      resultsByTournamentId: counts
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/debug-tournaments", (req, res) => {
  try {
    const file = path.join(DATA_DIR, "tournaments.json");
    const tournaments = loadJsonArray(file);
    res.json({
      file,
      count: tournaments.length,
      last: tournaments[tournaments.length - 1] || null
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const GET_TOURNAMENT_EVENTS = `
  query TournamentEvents($slug: String!) {
    tournament(slug: $slug) {
      id
      name
      events {
        id
        name
        slug
      }
    }
  }
`;

function extractTournamentSlugFromUrl(url) {
  // supports:
  // https://www.start.gg/tournament/14-kagaribi-14-8/events
  // https://start.gg/tournament/14-kagaribi-14-8
  const m = String(url).match(/start\.gg\/tournament\/([^\/?#]+)/i);
  return m ? `tournament/${m[1]}` : null;
}

app.get("/api/tournament-events", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing ?url=" });

    const tournamentSlug = extractTournamentSlugFromUrl(url);
    if (!tournamentSlug) {
      return res.status(400).json({ error: "Could not parse tournament slug from URL" });
    }

    const data = await startggQuery(GET_TOURNAMENT_EVENTS, { slug: tournamentSlug });

    res.json({
      tournamentSlug,
      tournamentName: data.tournament?.name ?? null,
      events: data.tournament?.events ?? []
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function requireAdmin(req) {
  const key = req.headers["x-admin-key"] || req.query.adminKey;
  return key && process.env.ADMIN_KEY && String(key) === String(process.env.ADMIN_KEY);
}

app.post("/api/import-event", async (req, res) => {
  try {
    if (!requireAdmin(req)) return res.status(401).json({ error: "Unauthorized" });

    const { eventSlug, season, tier } = req.body || {};
    if (!eventSlug) return res.status(400).json({ error: "Missing eventSlug" });
    if (!season) return res.status(400).json({ error: "Missing season" });
    if (!tier) return res.status(400).json({ error: "Missing tier" });

    // 1) get eventId from event slug
    const eventData = await startggQuery(GET_EVENT_WITH_TOURNAMENT, { slug: eventSlug });
    const eventId = eventData.event.id;

    // AUTO tournament info
    const tournamentId = "t_" + eventData.event.tournament.id;
    const safeName =
      eventData.event.tournament.name ||
      eventData.event.name ||
      tournamentId;

    // ✅ auto-add/update tournaments.json
    const tournamentUpsert = upsertTournament({
      tournamentId,
      season,
      tier,
      name: safeName,
      eventSlug: eventSlug
    });

    // 2) standings
    const nodes = await fetchAllStandings(eventId);

    // 3) mapping startgg.playerId -> your internal playerId
    const players = loadPlayersFile();
    const lookup = new Map();
    for (const p of players) {
      const sid = p?.startgg?.playerId;
      if (sid != null) lookup.set(Number(sid), p.playerId);
    }

    const mapped = [];
    const unmapped = [];

    for (const n of nodes) {
      const entrant = n.entrant;
      const firstParticipant = entrant?.participants?.[0];
      const player = firstParticipant?.player;

      const startggPlayerId = player?.id ?? null;
      const gamerTag = player?.gamerTag ?? firstParticipant?.gamerTag ?? entrant?.name ?? null;
      const mappedPlayerId =
        startggPlayerId != null ? lookup.get(Number(startggPlayerId)) : null;

      if (mappedPlayerId) {
        mapped.push({
          playerId: mappedPlayerId,
          tournamentId,
          placement: n.placement
        });
      } else {
        unmapped.push({
          startggPlayerId,
          gamerTag,
          entrantName: entrant?.name ?? null,
          placement: n.placement
        });
      }
    }

    // 4) append to results.json (dedupe by playerId+tournamentId)
    const resultsPath = path.join(DATA_DIR, "results.json");
    const existing = loadJsonArray(resultsPath);
    const key = (r) => `${r.playerId}__${r.tournamentId}`;
    const keys = new Set(existing.map(key));

    let appended = 0;
    for (const r of mapped) {
      if (!keys.has(key(r))) {
        existing.push(r);
        keys.add(key(r));
        appended++;
      }
    }

    writeJsonPretty(resultsPath, existing);

    await rebuildResultsCache();

    res.json({
  ok: true,

  // 👇 NEW: tournament info included in response
  tournament: {
    tournamentId,
    season: Number(season),
    tier,
    name: safeName
  },

  // 👇 NEW: tells frontend whether it was added or updated
  tournamentUpsert,

  // existing fields
  eventSlug,
  eventId,
  eventName: eventData.event.name,
  appended,
  mappedCount: mapped.length,
  unmappedCount: unmapped.length,
  unmapped
});
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

async function rebuildResultsCache() {
  if (CACHE_STATUS.rebuilding) return;

  CACHE_STATUS.rebuilding = true;
  CACHE_STATUS.lastError = null;
  CACHE_STATUS.tournamentsProcessed = 0;

  try {
    const tournaments = loadTournamentsFile();

    const built = [];

    for (const t of tournaments) {
      if (!t.eventSlug) continue; // can't rebuild without slug

      // 1) get eventId from slug
      const eventData = await startggQuery(GET_EVENT, { slug: t.eventSlug });
      const eventId = eventData.event.id;

      // 2) fetch ALL standings (paginated)
      const nodes = await fetchAllStandings(eventId);

      // 3) map standings -> your internal playerId results
      const players = loadPlayersFile();
      const lookup = new Map();
      for (const p of players) {
        const sid = p?.startgg?.playerId;
        if (sid != null) lookup.set(Number(sid), p.playerId);
      }

      for (const n of nodes) {
        const entrant = n.entrant;
        const firstParticipant = entrant?.participants?.[0];
        const player = firstParticipant?.player;

        const startggPlayerId = player?.id ?? null;
        const mappedPlayerId =
          startggPlayerId != null ? lookup.get(Number(startggPlayerId)) : null;

        if (mappedPlayerId) {
          built.push({
            playerId: mappedPlayerId,
            tournamentId: t.tournamentId,
            placement: Number(n.placement)
          });
        }
      }

      CACHE_STATUS.tournamentsProcessed++;
    }

    RESULTS_CACHE = built;
    CACHE_STATUS.resultsCount = built.length;
    CACHE_STATUS.lastRebuildAt = new Date().toISOString();
  } catch (e) {
    CACHE_STATUS.lastError = String(e);
  } finally {
    CACHE_STATUS.rebuilding = false;
  }
}

function upsertTournament({ tournamentId, season, tier, name, eventSlug }) {
  const tournamentsPath = path.join(DATA_DIR, "tournaments.json");
  const tournaments = loadJsonArray(tournamentsPath);

  const idx = tournaments.findIndex((t) => t.tournamentId === tournamentId);

  const entry = {
    tournamentId,
    season: Number(season),
    tier: tier,
    name: name,
    eventSlug
  };

  if (idx === -1) {
    tournaments.push(entry);
  } else {
    // update existing (keeps your file consistent if you change tier/name later)
    tournaments[idx] = { ...tournaments[idx], ...entry };
  }

  writeJsonPretty(tournamentsPath, tournaments);
  return { added: idx === -1, updated: idx !== -1 };
}

async function fetchAllStandings(eventId) {
  const perPage = 128;
  let page = 1;
  let all = [];

  while (true) {
    const data = await startggQuery(GET_STANDINGS, {
      eventId,
      page,
      perPage
    });

    const nodes = data?.event?.standings?.nodes || [];
    if (nodes.length === 0) break;

    all.push(...nodes);

    // If we got fewer than perPage, we’re done
    if (nodes.length < perPage) break;

    page++;
  }

  return all;
}

app.get(["/players", "/api/players"], (req, res) => {
  try {
    const players = loadPlayersFile();
    // optional: sort by tag
    players.sort((a, b) => String(a.tag || "").localeCompare(String(b.tag || "")));
    res.json({ ok: true, count: players.length, players });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/cache-status", (req, res) => {
  res.json({ ok: true, cache: CACHE_STATUS, resultsCacheCount: RESULTS_CACHE.length });
});

app.post("/admin/rebuild-cache", async (req, res) => {
  try {
    if (!requireAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
    await rebuildResultsCache();
    res.json({ ok: true, cache: CACHE_STATUS, resultsCacheCount: RESULTS_CACHE.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/debug-paths", (req, res) => {
  const rootDataDir = path.join(__dirname, "..", "data");
  const backendDataDir = path.join(__dirname, "data");

  const rootT = path.join(rootDataDir, "tournaments.json");
  const backT = path.join(backendDataDir, "tournaments.json");

  res.json({
    __dirname,
    rootTournamentsPath: rootT,
    rootTournamentsExists: fs.existsSync(rootT),
    backendTournamentsPath: backT,
    backendTournamentsExists: fs.existsSync(backT),
  });
});

rebuildResultsCache();

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`✅ Backend running: http://localhost:${port}`);
});