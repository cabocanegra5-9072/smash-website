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
  const btnAutoFill = document.getElementById("btnAutoFill");
if (btnAutoFill) {
  btnAutoFill.onclick = async () => {
    const adminKey = getAdminKey?.() || "";
    if (!adminKey) return alert("Enter admin key first.");

    const yearEl = document.getElementById("autoYear");
    const minEl = document.getElementById("minAttendees");
    const pastEl = document.getElementById("pastOnly");

    const year = Number((yearEl?.value || "").trim());
    const minAttendees = Number((minEl?.value || "").trim()) || 0;
    const past = pastEl?.value || "true";

    // setStatus may not exist on non-admin pages, so guard it
    if (typeof setStatus === "function") setStatus("Fetching tournaments from start.gg…");

    const res = await fetch(
      `/api/list-ultimate-tournaments?year=${encodeURIComponent(year)}&minAttendees=${encodeURIComponent(minAttendees)}&past=${encodeURIComponent(past)}`,
      { headers: { "X-Admin-Key": adminKey } }
    );

    const data = await res.json();
    if (!res.ok) {
      if (typeof setStatus === "function") setStatus("Error: " + (data.error || res.status));
      else alert("Error: " + (data.error || res.status));
      return;
    }

    const textarea = document.getElementById("bulkUrls");
    if (textarea) textarea.value = (data.urls || []).join("\n");

    if (typeof setStatus === "function") {
      setStatus(`✅ Auto-filled ${data.returned} tournaments. Now click "Load Events for All URLs", then "Import All".`);
    } else {
      alert(`✅ Auto-filled ${data.returned} tournaments.`);
    }
  };
}
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