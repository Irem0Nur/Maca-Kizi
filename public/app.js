const socket = io();

/* ---------- Oturum (sayfa yenilenince koltuğa geri dönmek için) ---------- */
function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

let token = storageGet("mk_token");
if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
  const bytes = new Uint8Array(18);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  storageSet("mk_token", token);
}

const savedName = storageGet("mk_name");

let roomCode = null;
let me = null;
let prevState = null;
let gameOverShown = false;
let peskirPromptTimer = null;
let peskirPromptShownForRound = null;
let timerInterval = null;
let currentDeadline = null;
let currentTurnSeconds = 20;

const $ = id => document.getElementById(id);

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[c]);

if (savedName) $("name").value = savedName;

// Davet linki: ?oda=KOD
const inviteCode = new URLSearchParams(location.search).get("oda");
if (inviteCode) {
  $("roomInput").value = inviteCode.toUpperCase();
  $("menuMsg").textContent = `Davet: ${inviteCode.toUpperCase()} odasına katılmak için adını yazıp "Katıl"a bas.`;
}

function playerName() {
  const n = $("name").value.trim() || "Oyuncu";
  storageSet("mk_name", n);
  return n;
}

function showMenu(message = "") {
  roomCode = null;
  me = null;
  prevState = null;
  gameOverShown = false;
  peskirPromptShownForRound = null;
  clearTimeout(peskirPromptTimer);
  storageSet("mk_room", null);
  $("game").classList.add("hidden");
  $("menu").classList.remove("hidden");
  $("gameOverOverlay").classList.add("hidden");
  $("lobbyOverlay").classList.add("hidden");
  $("peskirPrompt").classList.add("hidden");
  $("menuMsg").textContent = message;
}

const suitSymbol = suit => ({
  C: "♣",
  D: "♦",
  S: "♠",
  H: "♥"
})[suit];

const isRed = suit => suit === "H" || suit === "D";

$("botBtn").onclick = () => {
  socket.emit("botGame", { name: playerName(), token });
};

$("createBtn").onclick = () => {
  socket.emit("createRoom", { name: playerName(), token });
};

$("joinBtn").onclick = () => {
  const code = $("roomInput").value.trim();
  if (!code) return showToast("Oda kodunu yaz.");
  socket.emit("joinRoom", { roomCode: code, name: playerName(), token });
};

$("roomInput").addEventListener("keydown", e => {
  if (e.key === "Enter") $("joinBtn").click();
});

$("leaveBtn").onclick = () => {
  const inGame = prevState && prevState.started && !prevState.gameOver && prevState.mode === "online";
  if (inGame && !confirm("Oyundan çıkarsan hamlelerin otomatik oynanacak. Çıkmak istiyor musun?")) return;
  socket.emit("leaveRoom");
  showMenu();
};

$("menuBtn").onclick = () => {
  socket.emit("leaveRoom");
  showMenu();
};

$("rematchBtn").onclick = () => socket.emit("rematch");

$("copyLinkBtn").onclick = async () => {
  const link = `${location.origin}${location.pathname}?oda=${roomCode}`;
  try {
    await navigator.clipboard.writeText(link);
    showToast("Davet linki kopyalandı.");
  } catch {
    prompt("Davet linki:", link);
  }
};

socket.on("connect", () => {
  $("connBanner").classList.add("hidden");
  const savedRoom = storageGet("mk_room");
  if (savedRoom) socket.emit("resume", { token, roomCode: savedRoom });
});

socket.on("disconnect", () => {
  if (roomCode) $("connBanner").classList.remove("hidden");
});

socket.on("resumeFailed", () => {
  if (storageGet("mk_room")) showMenu("Önceki oda artık yok.");
});

socket.on("joined", data => {
  roomCode = data.roomCode;
  me = data.playerId;
  storageSet("mk_room", roomCode);

  if (inviteCode && history.replaceState) history.replaceState(null, "", location.pathname);

  $("menu").classList.add("hidden");
  $("game").classList.remove("hidden");
});

socket.on("left", () => {});
socket.on("kicked", msg => showMenu(msg));
socket.on("errorMessage", showToast);
socket.on("state", render);

$("peskirYes").onclick = () => {
  $("peskirPrompt").classList.add("hidden");
  clearTimeout(peskirPromptTimer);
  socket.emit("peskirDecision", { accept:true });
};

$("peskirNo").onclick = () => {
  $("peskirPrompt").classList.add("hidden");
  clearTimeout(peskirPromptTimer);
  socket.emit("peskirDecision", { accept:false });
};

function showToast(message) {
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");

  setTimeout(() => {
    $("toast").classList.add("hidden");
  }, 2200);
}

function showEvent(type) {
  const id = type === "kafa" ? "kafaOverlay" : "peskirOverlay";
  $(id).classList.remove("hidden");

  if (type === "kafa") {
    $("kafaSound").play().catch(() => {});
  }

  setTimeout(() => {
    $(id).classList.add("hidden");
  }, 1600);
}

function seatMap(players) {
  const myIndex = players.findIndex(p => p.id === me);
  if (myIndex < 0) return {};

  const relative = offset => players[(myIndex + offset) % 4] && (myIndex + offset) % 4 < players.length
    ? players[(myIndex + offset) % 4]
    : null;

  return {
    bottom: relative(0),
    left: relative(1),
    top: relative(2),
    right: relative(3)
  };
}

function renderSeat(id, player, state) {
  const el = $(id);
  if (!player) {
    el.innerHTML = "";
    return;
  }

  const base =
    id === "seatTop" ? "seat seat-top" :
    id === "seatLeft" ? "seat seat-left" :
    id === "seatRight" ? "seat seat-right" :
    "seat seat-bottom";

  el.className = `${base} ${player.id === state.currentPlayer ? "active" : ""}`;

  el.innerHTML = `
    <div class="avatar">${player.isBot ? "🤖" : player.id === me ? "👤" : "🙂"}</div>
    <div>
      <div class="seat-name">
        ${esc(player.name)}${player.id === me ? " (Sen)" : ""}
      </div>
      ${player.connected === false ? `<div class="seat-meta offline-tag">📴 Bağlı değil</div>` : ""}
      <div class="seat-meta">
        Ceza: ${player.penalty}<br>
        Kafa: ${player.kafa} 💥
        ${
          state.peskirAnswers?.[player.id]
            ? `<div class="peskir-answer ${state.peskirAnswers[player.id] === "EVET" ? "yes" : "no"}">
                 Peşkir: ${state.peskirAnswers[player.id]}
               </div>`
            : ""
        }
      </div>
    </div>
  `;
}

function renderBacks(id, count) {
  $(id).innerHTML = Array.from(
    { length: Math.min(count, 13) },
    (_, i) => `<div class="card-back" style="--i:${i}"></div>`
  ).join("");
}

function trickPosition(playerId, seats) {
  if (seats.top?.id === playerId) return "top";
  if (seats.left?.id === playerId) return "left";
  if (seats.right?.id === playerId) return "right";
  return "bottom";
}


function pipLayout(rank, suit) {
  const pip = suitSymbol(suit);

  // Pozisyonlar kartın orta güvenli alanındadır.
  // Köşe değerlerinin bulunduğu üst/alt bölgeler kullanılmaz.
  const layouts = {
    "2":  [[50,22],[50,78]],
    "3":  [[50,20],[50,50],[50,80]],
    "4":  [[28,22],[72,22],[28,78],[72,78]],
    "5":  [[28,22],[72,22],[50,50],[28,78],[72,78]],
    "6":  [[28,20],[72,20],[28,50],[72,50],[28,80],[72,80]],
    "7":  [[28,18],[72,18],[50,35],[28,50],[72,50],[28,82],[72,82]],
    "8":  [[28,18],[72,18],[50,34],[28,50],[72,50],[50,66],[28,82],[72,82]],
    "9":  [[28,17],[72,17],[28,36],[72,36],[50,50],[28,64],[72,64],[28,83],[72,83]],
    "10": [[28,15],[72,15],[50,27],[28,38],[72,38],[28,62],[72,62],[50,73],[28,85],[72,85]]
  };

  const points = layouts[rank] || [];

  return `
    <div class="pip-safe-area">
      ${points.map(([x,y], i) => `
        <span class="pip pip-${i}" style="left:${x}%;top:${y}%">${pip}</span>
      `).join("")}
    </div>
  `;
}

function cardCenter(card) {
  const suit = suitSymbol(card.suit);

  if (card.rank === "A") {
    return `
      <div class="face-layout">
        <div class="face-rank-large">A</div>
        <div class="face-suit-large">${suit}</div>
      </div>
    `;
  }

  if (["J","Q","K"].includes(card.rank)) {
    const decoration =
      card.rank === "J" ? "♞" :
      card.rank === "Q" ? "♛" :
      "♚";

    return `
      <div class="face-layout">
        <div class="face-decoration">${decoration}</div>
        <div class="face-rank-large">${card.rank}</div>
        <div class="face-suit-large">${suit}</div>
      </div>
    `;
  }

  return pipLayout(card.rank, card.suit);
}

function playingCardHTML(card, extraClass = "") {
  const suit = suitSymbol(card.suit);

  return `
    <div class="playing-card ${isRed(card.suit) ? "red" : ""} ${extraClass}">
      <div class="card-corner">
        <span class="corner-rank">${card.rank}</span>
        <span class="corner-suit">${suit}</span>
      </div>

      <div class="card-center">${cardCenter(card)}</div>

      <div class="card-corner bottom">
        <span class="corner-rank">${card.rank}</span>
        <span class="corner-suit">${suit}</span>
      </div>
    </div>
  `;
}

function showGameOver(state) {
  if (gameOverShown) return;
  gameOverShown = true;

  const losers = new Set(state.loserIds || [state.loserId]);

  const sorted = [...state.players].sort((a, b) => {
    const aLost = losers.has(a.id);
    const bLost = losers.has(b.id);

    if (aLost !== bLost) return aLost ? 1 : -1;
    if (a.penalty !== b.penalty) return a.penalty - b.penalty;
    return a.kafa - b.kafa;
  });

  const lostNames = state.players
    .filter(p => losers.has(p.id))
    .map(p => p.name);

  const isHost = state.hostId === me;
  const canRematch = state.mode === "bot" || isHost;
  $("rematchBtn").classList.toggle("hidden", !canRematch);
  $("rematchHint").textContent = canRematch ? "" : "Rövanşı oda sahibi başlatabilir.";

  $("gameOverReason").textContent =
    `${lostNames.join(", ")} kaybetti. Kaybetme sınırı: 5 Kafa veya 180 ceza puanı.`;

  $("finalScoreboard").innerHTML = sorted.map((p, index) => {
    const lost = losers.has(p.id);

    return `
      <div class="final-row ${lost ? "lost" : index === 0 ? "best" : ""}">
        <span>${index + 1}</span>
        <strong>${esc(p.name)}${p.id === me ? " (Sen)" : ""}</strong>
        <span>${p.penalty}</span>
        <span>${p.kafa}</span>
        <span class="${lost ? "badge-lost" : "badge-safe"}">
          ${lost ? "KAYBETTİ" : "DEVAM"}
        </span>
      </div>
    `;
  }).join("");

  setTimeout(() => {
    $("gameOverOverlay").classList.remove("hidden");
  }, 650);
}


function updateTurnTimer(deadline, turnSeconds) {
  currentDeadline = deadline;
  currentTurnSeconds = turnSeconds || 20;

  if (timerInterval) clearInterval(timerInterval);

  const draw = () => {
    const timer = $("turnTimer");
    const fill = $("timerFill");

    if (!currentDeadline) {
      timer.textContent = "—";
      timer.classList.remove("danger");
      fill.style.width = "0%";
      return;
    }

    const leftMs = Math.max(0, currentDeadline - Date.now());
    const leftSec = Math.ceil(leftMs / 1000);
    const percent = Math.max(0, Math.min(100, (leftMs / (currentTurnSeconds * 1000)) * 100));

    timer.textContent = leftSec;
    fill.style.width = `${percent}%`;

    if (leftSec <= 5) timer.classList.add("danger");
    else timer.classList.remove("danger");
  };

  draw();
  timerInterval = setInterval(draw, 200);
}

function render(state) {
  $("roomCode").textContent = state.roomCode;
  $("modeLabel").textContent =
    state.mode === "bot" ? "＋ 1 Oyuncu + 3 Bot" : "🌐 Online Oyun";

  $("roundInfo").textContent = state.round;

  const myPlayer = state.players.find(p => p.id === me);
  const played = myPlayer?.hand ? 13 - myPlayer.hand.length : 0;
  $("trickInfo").textContent = `${played} / 13`;

  const current = state.players.find(p => p.id === state.currentPlayer);
  $("turnInfo").textContent = current?.name || "Bekleniyor";

  // Rövanş başladıysa sonuç ekranını kapat.
  if (!state.gameOver && gameOverShown) {
    gameOverShown = false;
    $("gameOverOverlay").classList.add("hidden");
  }

  renderLobby(state);

  updateTurnTimer(state.turnDeadline, state.turnSeconds);
  $("heartInfo").textContent = state.heartsBroken ? "Kırıldı ♥" : "Kırılmadı";

  const seats = seatMap(state.players);

  renderSeat("seatBottom", seats.bottom, state);
  renderSeat("seatLeft", seats.left, state);
  renderSeat("seatTop", seats.top, state);
  renderSeat("seatRight", seats.right, state);

  renderBacks("backsTop", seats.top?.handCount || 0);
  renderBacks("backsLeft", seats.left?.handCount || 0);
  renderBacks("backsRight", seats.right?.handCount || 0);

  $("scoreboard").innerHTML = state.players.map(p => `
    <div class="score-row
      ${p.id === me ? "me" : ""}
      ${p.id === state.currentPlayer ? "active" : ""}
      ${(state.loserIds || []).includes(p.id) ? "loser" : ""}">
      <span>${p.isBot ? "🤖" : p.connected === false ? "📴" : "♠"} ${esc(p.name)}${p.id === me ? " (Sen)" : ""}</span>
      <span>${p.penalty}</span>
      <span>${p.kafa}</span>
    </div>
  `).join("");

  $("table").innerHTML = state.trick.map(t => {
    const player = state.players.find(p => p.id === t.playerId);
    const pos = trickPosition(t.playerId, seats);

    return `
      <div class="played-card-wrap ${pos}">
        ${playingCardHTML(t.card, "played-card")}
        <small>${esc(player?.name || "")}</small>
      </div>
    `;
  }).join("");

  if (myPlayer?.hand) {
    const legalIds = new Set(state.legalCardIds || []);
    const myTurn = state.currentPlayer === me && !state.waitingPeskir;

    $("hand").innerHTML = myPlayer.hand.map(card => {
      const legal = myTurn && legalIds.has(card.id);

      return `
        <button
          class="hand-card-button ${legal ? "playable" : "disabled rule-blocked"}"
          ${legal ? "" : "disabled"}
          onclick="play('${card.id}')">
          ${playingCardHTML(card)}
          ${legal ? "" : `<span class="blocked-mark">⛔</span>`}
        </button>
      `;
    }).join("");
  }

  if (state.gameOver) {
    $("status").innerHTML = `☠️ <strong>Oyun bitti.</strong> Sonuçlar gösteriliyor...`;
  } else if (state.waitingPeskir) {
    $("status").innerHTML = `🧣 <strong>Peşkir kararları bekleniyor.</strong> Cevaplar tüm oyuncular tarafından görülecek.`;
  } else if (state.players.length < 4) {
    $("status").textContent = `Oyuncu bekleniyor (${state.players.length}/4)...`;
  } else {
    $("status").innerHTML = state.heartsBroken
      ? `♥ <strong>Kupa kırıldı.</strong> Kupa ile başlanabilir.`
      : `Kupa henüz kırılmadı. Sıra: <strong>${esc(current?.name || "-")}</strong>`;
  }

  $("log").innerHTML = state.log
    .slice()
    .reverse()
    .map(x => `<div>${esc(x)}</div>`)
    .join("");

  if (prevState) {
    const oldLog = new Set(prevState.log || []);
    const fresh = state.log.filter(x => !oldLog.has(x));

    if (fresh.some(x => x.includes("KAFA"))) showEvent("kafa");
    else if (fresh.some(x => x.includes("PEŞKİR"))) showEvent("peskir");
  }

  // Peşkir sorusu kartlar ekranda göründükten SONRA açılır.
  // Böylece oyuncu önce elindeki 13 kartı görebilir.
  updatePeskirCountdown(state.peskirDeadline);

  // Peşkir sorusu kartlar ekranda göründükten 5 sn SONRA açılır.
  // Böylece oyuncu önce elindeki 13 kartı inceleyebilir.
  // Zaman sunucunun verdiği süreye göre hesaplanır; sayfa yenilense de doğru çalışır.
  if (state.pendingPeskirForViewer && !state.gameOver) {
    if (peskirPromptShownForRound !== state.dealId) {
      peskirPromptShownForRound = state.dealId;
      clearTimeout(peskirPromptTimer);
      $("peskirPrompt").classList.add("hidden");

      const decideMs = (state.peskirDecideSeconds || 20) * 1000;
      const openAt = state.peskirDeadline ? state.peskirDeadline - decideMs : Date.now() + 5000;
      const dealId = state.dealId;

      peskirPromptTimer = setTimeout(() => {
        if (prevState && prevState.dealId === dealId && prevState.pendingPeskirForViewer && !prevState.gameOver) {
          $("peskirPrompt").classList.remove("hidden");
        }
      }, Math.max(0, Math.min(5000, openAt - Date.now())));
    }
  } else {
    clearTimeout(peskirPromptTimer);
    $("peskirPrompt").classList.add("hidden");
  }

  if (state.gameOver) showGameOver(state);

  prevState = JSON.parse(JSON.stringify(state));
}

let peskirCountdownInterval = null;
function updatePeskirCountdown(deadline) {
  clearInterval(peskirCountdownInterval);
  const draw = () => {
    if (!deadline) { $("peskirCountdown").textContent = ""; return; }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    $("peskirCountdown").textContent = `Kalan süre: ${left} sn (cevap vermezsen HAYIR sayılır)`;
  };
  draw();
  if (deadline) peskirCountdownInterval = setInterval(draw, 250);
}

function renderLobby(state) {
  const inLobby = state.mode === "online" && !state.started;
  $("lobbyOverlay").classList.toggle("hidden", !inLobby);
  if (!inLobby) return;

  $("lobbyCode").textContent = state.roomCode;

  const seats = [];
  for (let i = 0; i < 4; i++) {
    const p = state.players[i];
    if (!p) {
      seats.push(`<div class="lobby-seat empty"><span class="ls-avatar">➕</span><span>Boş koltuk</span></div>`);
      continue;
    }
    const tags = [
      p.id === state.hostId ? "Oda sahibi" : "",
      p.id === me ? "Sen" : "",
      p.connected === false ? "Bağlantı koptu" : ""
    ].filter(Boolean).join(" · ");
    seats.push(`
      <div class="lobby-seat ${p.connected === false ? "offline" : ""}">
        <span class="ls-avatar">${p.isBot ? "🤖" : p.id === me ? "👤" : "🙂"}</span>
        <div style="min-width:0">
          <div class="ls-name">${esc(p.name)}</div>
          <div class="ls-tag">${tags}</div>
        </div>
      </div>`);
  }
  $("lobbySeats").innerHTML = seats.join("");

  const isHost = state.hostId === me;
  const missing = 4 - state.players.length;
  $("lobbyHostArea").innerHTML = isHost && missing > 0
    ? `<button class="yes-btn" id="fillBotsBtn">🤖 Kalan ${missing} koltuğu botla doldur ve başla</button>`
    : "";
  const btn = $("fillBotsBtn");
  if (btn) btn.onclick = () => socket.emit("fillWithBots");

  $("lobbyHint").textContent = isHost
    ? "4 kişi olunca oyun kendiliğinden başlar. İstersen boş yerleri botla doldurabilirsin."
    : `${state.players.length}/4 oyuncu. 4 kişi olunca oyun kendiliğinden başlar.`;
}

window.play = cardId => {
  socket.emit("playCard", { cardId });
};
