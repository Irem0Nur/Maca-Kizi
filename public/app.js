const socket = io();

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

const suitSymbol = suit => ({
  C: "♣",
  D: "♦",
  S: "♠",
  H: "♥"
})[suit];

const isRed = suit => suit === "H" || suit === "D";

$("botBtn").onclick = () => {
  socket.emit("botGame", {
    name: $("name").value.trim() || "Oyuncu"
  });
};

$("createBtn").onclick = () => {
  socket.emit("createRoom", {
    name: $("name").value.trim() || "Oyuncu"
  });
};

$("joinBtn").onclick = () => {
  socket.emit("joinRoom", {
    roomCode: $("roomInput").value,
    name: $("name").value.trim() || "Oyuncu"
  });
};

socket.on("joined", data => {
  roomCode = data.roomCode;
  me = data.playerId;

  $("menu").classList.add("hidden");
  $("game").classList.remove("hidden");
});

socket.on("errorMessage", showToast);
socket.on("state", render);

$("peskirYes").onclick = () => {
  $("peskirPrompt").classList.add("hidden");
  clearTimeout(peskirPromptTimer);
  socket.emit("peskirDecision", { roomCode, accept:true });
};

$("peskirNo").onclick = () => {
  $("peskirPrompt").classList.add("hidden");
  clearTimeout(peskirPromptTimer);
  socket.emit("peskirDecision", { roomCode, accept:false });
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
  if (myIndex < 0 || players.length !== 4) return {};

  const relative = offset => players[(myIndex + offset) % 4];

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
        ${player.name}${player.id === me ? " (Sen)" : ""}
      </div>
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

  $("gameOverReason").textContent =
    `${lostNames.join(", ")} kaybetti. Kaybetme sınırı: 5 Kafa veya 180 ceza puanı.`;

  $("finalScoreboard").innerHTML = sorted.map((p, index) => {
    const lost = losers.has(p.id);

    return `
      <div class="final-row ${lost ? "lost" : index === 0 ? "best" : ""}">
        <span>${index + 1}</span>
        <strong>${p.name}${p.id === me ? " (Sen)" : ""}</strong>
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
      <span>${p.isBot ? "🤖" : "♠"} ${p.name}${p.id === me ? " (Sen)" : ""}</span>
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
        <small>${player?.name || ""}</small>
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
      : `Kupa henüz kırılmadı. Sıra: <strong>${current?.name || "-"}</strong>`;
  }

  $("log").innerHTML = state.log
    .slice()
    .reverse()
    .map(x => `<div>${x}</div>`)
    .join("");

  if (prevState) {
    const oldLog = new Set(prevState.log || []);
    const fresh = state.log.filter(x => !oldLog.has(x));

    if (fresh.some(x => x.includes("KAFA"))) showEvent("kafa");
    else if (fresh.some(x => x.includes("PEŞKİR"))) showEvent("peskir");
  }

  // Peşkir sorusu kartlar ekranda göründükten SONRA açılır.
  // Böylece oyuncu önce elindeki 13 kartı görebilir.
  if (state.pendingPeskirForViewer && !state.gameOver) {
    if (peskirPromptShownForRound !== state.round) {
      clearTimeout(peskirPromptTimer);
      $("peskirPrompt").classList.add("hidden");

      peskirPromptTimer = setTimeout(() => {
        // Hâlâ aynı turda karar bekleniyorsa pencereyi göster.
        if (
          prevState &&
          prevState.round === state.round &&
          prevState.pendingPeskirForViewer &&
          !prevState.gameOver
        ) {
          $("peskirPrompt").classList.remove("hidden");
          peskirPromptShownForRound = state.round;
        }
      }, 5000);
    }
  } else {
    clearTimeout(peskirPromptTimer);
    $("peskirPrompt").classList.add("hidden");
  }

  if (state.gameOver) showGameOver(state);

  prevState = JSON.parse(JSON.stringify(state));
}

window.play = cardId => {
  socket.emit("playCard", {
    roomCode,
    cardId
  });
};
