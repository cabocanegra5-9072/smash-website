const CURRENT_SEASON = 2025;

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

// ---------- LEADERBOARD PAGE ----------
async function initLeaderboardPage() {
  const tbody = document.getElementById("players-body");
  if (!tbody) return; // not on leaderboard page

  try {
    const res = await fetch(`/leaderboard?season=${CURRENT_SEASON}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    tbody.innerHTML = "";
    for (const r of data.leaderboard || []) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.rank}</td>
        <td>${escapeHtml(r.tag ?? "")}</td>
        <td>${escapeHtml(r.region ?? "")}</td>
        <td>${r.points}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="4">Error loading leaderboard.</td></tr>`;
  }
}

document.getElementById("btnAutoFill").onclick = async () => {
  const adminKey = getAdminKey();
  if (!adminKey) return alert("Enter admin key first.");

  const year = Number(document.getElementById("autoYear").value.trim());
  const minAttendees = Number(document.getElementById("minAttendees").value.trim()) || 0;
  const past = document.getElementById("pastOnly").value;

  setStatus("Fetching tournaments from start.gg…");

  const res = await fetch(
    `/api/list-ultimate-tournaments?year=${encodeURIComponent(year)}&minAttendees=${encodeURIComponent(minAttendees)}&past=${encodeURIComponent(past)}`,
    { headers: { "X-Admin-Key": adminKey } }
  );

  const data = await res.json();
  if (!res.ok) {
    setStatus("Error: " + (data.error || res.status));
    return;
  }

  // Fill textarea with URLs
  const textarea = document.getElementById("bulkUrls");
  textarea.value = (data.urls || []).join("\n");

  setStatus(`✅ Auto-filled ${data.returned} tournaments. Now click "Load Events for All URLs", then "Import All".`);
};

// ---------- PLAYERS PAGE ----------
async function initPlayersPage() {
  const tbody = document.getElementById("players-table-body");
  if (!tbody) return; // not on players page

  const status = document.getElementById("players-status");
  const search = document.getElementById("players-search");

  let allPlayers = [];

  function render() {
    const q = (search?.value || "").trim().toLowerCase();
    const rows = q
      ? allPlayers.filter(p => (p.tag || "").toLowerCase().includes(q))
      : allPlayers;

    tbody.innerHTML = "";
    for (const p of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(p.tag || "")}</td>
        <td>${escapeHtml(p.region || "")}</td>
        <td>${escapeHtml(p.playerId || "")}</td>
        <td>${escapeHtml(String(p?.startgg?.playerId ?? ""))}</td>
      `;
      tbody.appendChild(tr);
    }

    if (status) status.textContent = `${rows.length} shown / ${allPlayers.length} total`;
  }

  try {
    if (status) status.textContent = "Loading...";
    const res = await fetch("/api/players");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    allPlayers = data.players || [];
    render();

    if (search) search.addEventListener("input", render);
  } catch (err) {
    console.error(err);
    if (status) status.textContent = "Error loading players.";
  }
}

// ---------- run ----------
document.addEventListener("DOMContentLoaded", () => {
  initLeaderboardPage();
  initPlayersPage();
});