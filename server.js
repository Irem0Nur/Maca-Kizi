import express from "express";
import http from "http";
import crypto from "crypto";
import { Server } from "socket.io";
import { createGame, playCard, chooseBotCard, resolveTrick, legalCards, applyPeskirDecision } from "./src/game.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();
const botTimers = new Map();
const turnTimers = new Map();
const peskirTimers = new Map();
const cleanupTimers = new Map();

const TURN_SECONDS = 20;
// Kartlar dağıtıldıktan sonra 5 sn inceleme + 20 sn karar süresi.
const PESKIR_REVIEW_SECONDS = 5;
const PESKIR_DECIDE_SECONDS = 20;
// Bağlantısı kopan oyuncu bu süre içinde dönerse hiçbir şey kaybetmez.
// Süre aşılırsa hamleleri (kurallara uygun en düşük kart) hızlı oynanır.
const AWAY_GRACE_MS = 30_000;
const AWAY_MOVE_DELAY_MS = 1500;
// Lobide kopan oyuncunun yeri bu süre sonra boşaltılır.
const LOBBY_LEAVE_MS = 20_000;
// Kimse bağlı değilse oda bu süre sonra silinir.
const EMPTY_ROOM_MS = 10 * 60_000;

const BOT_NAMES = ["Bot 1", "Bot 2", "Bot 3"];

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function cleanName(name, fallback) {
  const s = String(name ?? "").replace(/[<>&"'`]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return s || fallback;
}

function cleanToken(token) {
  const s = String(token ?? "");
  return /^[A-Za-z0-9_-]{16,64}$/.test(s) ? s : null;
}

function makePlayer({ name, token, socketId, isBot = false }) {
  return {
    id: isBot ? newId("bot") : newId("p"),
    token: token || null,
    socketId: socketId || null,
    connected: !isBot,
    disconnectedAt: null,
    name,
    hand: [],
    penalty: 0,
    kafa: 0,
    tricksWon: 0,
    isBot
  };
}

function isAway(player) {
  return !player.isBot && !player.connected &&
    player.disconnectedAt && Date.now() - player.disconnectedAt >= AWAY_GRACE_MS;
}

function publicState(game, viewerId) {
  return {
    mode: game.mode,
    roomCode: game.roomCode,
    hostId: game.hostId || null,
    started: Boolean(game.started),
    dealId: game.dealId || 0,
    currentPlayer: game.currentPlayer,
    leadSuit: game.leadSuit,
    heartsBroken: game.heartsBroken,
    trick: game.trick,
    trickResolving: game.trickResolving,
    round: game.round,
    gameOver: game.gameOver,
    loserId: game.loserId,
    loserIds: game.loserIds || [],
    waitingPeskir: game.waitingPeskir || false,
    pendingPeskirForViewer: (game.pendingPeskir || []).includes(viewerId),
    peskirAnswers: game.peskirAnswers || {},
    peskirDeadline: game.peskirDeadline || null,
    peskirDecideSeconds: PESKIR_DECIDE_SECONDS,
    turnDeadline: game.turnDeadline || null,
    turnSeconds: TURN_SECONDS,
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      penalty: p.penalty,
      kafa: p.kafa,
      tricksWon: p.tricksWon,
      handCount: p.hand.length,
      hand: p.id === viewerId ? p.hand : undefined,
      isBot: p.isBot,
      connected: p.isBot ? true : p.connected
    })),
    legalCardIds: (() => {
      const viewer = game.players.find(p => p.id === viewerId);
      if (!viewer || game.currentPlayer !== viewerId || game.waitingPeskir) return [];
      return legalCards(game, viewer).map(c => c.id);
    })(),
    log: game.log.slice(-24)
  };
}

function emitRoom(game) {
  for (const p of game.players) {
    if (p.socketId && p.connected) {
      io.to(p.socketId).emit("state", publicState(game, p.id));
    }
  }
}

/* ---------------- Zamanlayıcılar ---------------- */

function clearTimer(map, roomCode) {
  const timer = map.get(roomCode);
  if (timer) clearTimeout(timer);
  map.delete(roomCode);
}

function clearAllTimers(roomCode) {
  clearTimer(turnTimers, roomCode);
  clearTimer(botTimers, roomCode);
  clearTimer(peskirTimers, roomCode);
}

function chooseTimeoutCard(game, player) {
  const legal = legalCards(game, player);
  if (!legal.length) return null;

  // Süre bitince mümkün olan en düşük kart otomatik oynanır.
  return [...legal].sort((a, b) => a.value - b.value)[0];
}

// Bir kart oynandıktan sonra oyunun nasıl devam edeceğini tek yerden yönetir.
function afterPlay(game, result) {
  clearTimer(turnTimers, game.roomCode);

  if (result.trickComplete) {
    // Dördüncü kart 1.3 saniye masada kalsın.
    game.turnDeadline = null;
    emitRoom(game);
    scheduleTrickResolution(game, 1300);
  } else {
    scheduleBotTurn(game, 900);
    startTurnTimer(game);
  }
}

function startTurnTimer(game) {
  clearTimer(turnTimers, game.roomCode);

  if (game.gameOver || game.waitingPeskir || game.trickResolving || !game.currentPlayer) {
    game.turnDeadline = null;
    emitRoom(game);
    return;
  }

  const currentId = game.currentPlayer;
  const current = game.players.find(p => p.id === currentId);
  const away = current && isAway(current);
  const delay = away ? AWAY_MOVE_DELAY_MS : TURN_SECONDS * 1000;

  game.turnDeadline = Date.now() + delay;
  emitRoom(game);

  const timer = setTimeout(() => {
    if (game.gameOver || game.waitingPeskir || game.trickResolving || game.currentPlayer !== currentId) return;

    const player = game.players.find(p => p.id === currentId);
    if (!player) return;

    const card = chooseTimeoutCard(game, player);
    if (!card) return;

    game.log.push(away
      ? `📴 ${player.name} bağlı değil. ${card.id} otomatik atıldı.`
      : `⏱️ ${player.name} süresini doldurdu. ${card.id} otomatik atıldı.`);

    const result = playCard(game, player.id, card.id);
    if (result.ok) afterPlay(game, result);
  }, delay);

  turnTimers.set(game.roomCode, timer);
}

function scheduleTrickResolution(game, delay = 1300) {
  setTimeout(() => {
    if (!game.trickResolving || game.gameOver) return;

    const dealBefore = game.dealId;
    resolveTrick(game);

    if (game.gameOver) {
      clearAllTimers(game.roomCode);
      game.turnDeadline = null;
      game.peskirDeadline = null;
      emitRoom(game);
      return;
    }

    if (game.dealId !== dealBefore) {
      // Son el yeni turu başlattı: Peşkir aşaması.
      afterDeal(game);
    } else {
      scheduleBotTurn(game, 900);
      startTurnTimer(game);
    }
  }, delay);
}

// Kartlar dağıtıldıktan hemen sonra çağrılır (ilk tur, yeni tur, rövanş).
function afterDeal(game) {
  clearAllTimers(game.roomCode);
  game.turnDeadline = null;

  if (!game.waitingPeskir) {
    game.peskirDeadline = null;
    emitRoom(game);
    scheduleBotTurn(game, 1100);
    startTurnTimer(game);
    return;
  }

  // Peşkir penceresi istemcide 5 sn inceleme sonrası açılır;
  // karar için ayrıca 20 sn verilir. Süre biterse cevap HAYIR sayılır.
  game.peskirDeadline = Date.now() + (PESKIR_REVIEW_SECONDS + PESKIR_DECIDE_SECONDS) * 1000;
  emitRoom(game);

  resolveBotPeskirs(game, PESKIR_REVIEW_SECONDS * 1000 + 500);
  scheduleAwayPeskirs(game);

  const dealId = game.dealId;
  const timer = setTimeout(() => {
    if (!game.waitingPeskir || game.dealId !== dealId) return;

    for (const id of [...game.pendingPeskir]) {
      const p = game.players.find(x => x.id === id);
      game.log.push(`⏱️ ${p?.name || "Oyuncu"} Peşkir için süresini doldurdu.`);
      applyPeskirDecision(game, id, false);
    }
    onPeskirChanged(game);
  }, (PESKIR_REVIEW_SECONDS + PESKIR_DECIDE_SECONDS) * 1000);

  peskirTimers.set(game.roomCode, timer);
}

// Uzun süredir bağlı olmayan oyuncular Peşkir'de beklenmez (HAYIR).
function scheduleAwayPeskirs(game) {
  const dealId = game.dealId;
  setTimeout(() => {
    if (!game.waitingPeskir || game.dealId !== dealId) return;
    let changed = false;
    for (const p of game.players) {
      if (isAway(p) && game.pendingPeskir.includes(p.id)) {
        game.log.push(`📴 ${p.name} bağlı değil; Peşkir: HAYIR sayıldı.`);
        applyPeskirDecision(game, p.id, false);
        changed = true;
      }
    }
    if (changed) onPeskirChanged(game);
  }, PESKIR_REVIEW_SECONDS * 1000 + 300);
}

function onPeskirChanged(game) {
  if (!game.waitingPeskir && !game.gameOver) {
    clearTimer(peskirTimers, game.roomCode);
    game.peskirDeadline = null;
    scheduleBotTurn(game, 900);
    startTurnTimer(game);
  } else {
    emitRoom(game);
  }
}

function resolveBotPeskirs(game, delay = 650) {
  if (!game.waitingPeskir || game.gameOver) return;

  const dealId = game.dealId;
  const pendingBotIds = (game.pendingPeskir || []).filter(id => {
    const p = game.players.find(x => x.id === id);
    return p?.isBot;
  });

  pendingBotIds.forEach((botId, index) => {
    setTimeout(() => {
      if (game.dealId !== dealId || !game.waitingPeskir || !game.pendingPeskir.includes(botId)) return;

      // Botlar Peşkir ilanını EVET olarak cevaplar.
      applyPeskirDecision(game, botId, true);
      onPeskirChanged(game);
    }, delay + index * 450);
  });
}

function scheduleBotTurn(game, delay = 900) {
  clearTimer(botTimers, game.roomCode);

  if (game.gameOver || game.trickResolving || game.waitingPeskir) return;

  const current = game.players.find(p => p.id === game.currentPlayer);
  if (!current?.isBot) return;

  const timer = setTimeout(() => {
    if (game.gameOver || game.waitingPeskir || game.trickResolving) return;

    const bot = game.players.find(p => p.id === game.currentPlayer);
    if (!bot?.isBot) return;

    const card = chooseBotCard(game, bot);
    if (!card) return;

    const result = playCard(game, bot.id, card.id);
    if (result.ok) afterPlay(game, result);
  }, delay);

  botTimers.set(game.roomCode, timer);
}

/* ---------------- Oda yönetimi ---------------- */

function attach(socket, game, player) {
  // Aynı oyuncunun eski sekmesi açıksa onu odadan çıkar.
  if (player.socketId && player.socketId !== socket.id) {
    const old = io.sockets.sockets.get(player.socketId);
    if (old) {
      old.emit("kicked", "Bu oyuncu başka bir sekmede açıldı.");
      old.data.roomCode = null;
      old.leave(game.roomCode);
    }
  }

  player.socketId = socket.id;
  player.connected = true;
  player.disconnectedAt = null;

  socket.data.roomCode = game.roomCode;
  socket.data.playerId = player.id;
  socket.join(game.roomCode);

  clearTimer(cleanupTimers, game.roomCode);

  socket.emit("joined", {
    roomCode: game.roomCode,
    playerId: player.id,
    mode: game.mode
  });
}

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const game = rooms.get(code);
  socket.data.roomCode = null;
  socket.leave(code);
  if (!game) return;

  const player = game.players.find(p => p.id === socket.data.playerId);
  if (!player) return;

  if (!game.started) {
    removeFromLobby(game, player);
  } else {
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    if (game.mode === "online" && !game.gameOver) game.log.push(`🚪 ${player.name} oyundan ayrıldı.`);
    emitRoom(game);
    scheduleCleanupIfEmpty(game);
  }
}

function removeFromLobby(game, player) {
  game.players = game.players.filter(p => p.id !== player.id);
  game.log.push(`${player.name} odadan ayrıldı.`);

  if (game.hostId === player.id) {
    game.hostId = game.players.find(p => !p.isBot)?.id || null;
  }

  if (!game.players.some(p => !p.isBot)) {
    deleteRoom(game.roomCode);
    return;
  }

  emitRoom(game);
}

function deleteRoom(code) {
  clearAllTimers(code);
  clearTimer(cleanupTimers, code);
  rooms.delete(code);
}

function scheduleCleanupIfEmpty(game) {
  if (game.players.some(p => !p.isBot && p.connected)) return;
  clearTimer(cleanupTimers, game.roomCode);
  cleanupTimers.set(game.roomCode, setTimeout(() => {
    if (!game.players.some(p => !p.isBot && p.connected)) deleteRoom(game.roomCode);
  }, game.mode === "bot" ? 3 * 60_000 : EMPTY_ROOM_MS));
}

function newRoomCode() {
  // Karışan harfler (0/O, 1/I) kullanılmaz.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function startOnlineGame(game) {
  game.log.push("Masa doldu, kartlar dağıtılıyor.");
  game.startRound();
  afterDeal(game);
}

function resetForRematch(game) {
  for (const p of game.players) {
    p.penalty = 0;
    p.kafa = 0;
    p.tricksWon = 0;
    p.hand = [];
    p.roundPenalty = 0;
  }
  game.round = 1;
  game.gameOver = false;
  game.loserId = null;
  game.loserIds = [];
  game.log = ["🔁 Rövanş başladı!"];
  game.startRound();
  afterDeal(game);
}

/* ---------------- Socket olayları ---------------- */

io.on("connection", socket => {
  const getGame = () => rooms.get(socket.data.roomCode);
  const getMe = game => game?.players.find(p => p.id === socket.data.playerId);

  socket.on("resume", ({ token, roomCode } = {}) => {
    const t = cleanToken(token);
    const game = rooms.get(String(roomCode || "").toUpperCase());
    const player = t && game?.players.find(p => p.token === t);

    if (!player) return socket.emit("resumeFailed");

    attach(socket, game, player);
    if (game.mode === "online" && game.started && !game.gameOver) {
      game.log.push(`🔌 ${player.name} geri döndü.`);
    }

    // Oyuncu yokken sırası geldiyse normal 20 sn süresini geri ver.
    if (game.currentPlayer === player.id && !game.waitingPeskir && !game.trickResolving) {
      startTurnTimer(game);
    } else {
      emitRoom(game);
    }
  });

  socket.on("botGame", ({ name, token } = {}) => {
    const t = cleanToken(token);
    if (!t) return socket.emit("errorMessage", "Oturum hatası, sayfayı yenile.");
    leaveCurrentRoom(socket);

    const code = `BOT-${newRoomCode()}`;
    const game = createGame("bot", code);
    const human = makePlayer({ name: cleanName(name, "Oyuncu"), token: t, socketId: socket.id });
    game.players = [human, ...BOT_NAMES.map(n => makePlayer({ name: n, isBot: true }))];
    game.hostId = human.id;
    game.startRound();

    rooms.set(game.roomCode, game);
    attach(socket, game, human);
    afterDeal(game);
  });

  socket.on("createRoom", ({ name, token } = {}) => {
    const t = cleanToken(token);
    if (!t) return socket.emit("errorMessage", "Oturum hatası, sayfayı yenile.");
    leaveCurrentRoom(socket);

    const game = createGame("online", newRoomCode());
    const player = makePlayer({ name: cleanName(name, "Oyuncu 1"), token: t, socketId: socket.id });
    game.players.push(player);
    game.hostId = player.id;
    game.log.push(`${player.name} odayı kurdu.`);

    rooms.set(game.roomCode, game);
    attach(socket, game, player);
    emitRoom(game);
  });

  socket.on("joinRoom", ({ roomCode, name, token } = {}) => {
    const t = cleanToken(token);
    if (!t) return socket.emit("errorMessage", "Oturum hatası, sayfayı yenile.");

    const code = String(roomCode || "").trim().toUpperCase();
    const game = rooms.get(code);

    if (!game || game.mode !== "online") return socket.emit("errorMessage", "Oda bulunamadı.");

    // Aynı tarayıcı zaten bu odadaysa koltuğunu geri al.
    const existing = game.players.find(p => p.token === t);
    if (existing) {
      attach(socket, game, existing);
      return emitRoom(game);
    }

    if (game.started) return socket.emit("errorMessage", "Bu odada oyun başladı.");
    if (game.players.length >= 4) return socket.emit("errorMessage", "Oda dolu.");

    leaveCurrentRoom(socket);

    const player = makePlayer({
      name: cleanName(name, `Oyuncu ${game.players.length + 1}`),
      token: t,
      socketId: socket.id
    });
    game.players.push(player);
    game.log.push(`${player.name} odaya katıldı (${game.players.length}/4).`);
    attach(socket, game, player);

    if (game.players.length === 4) startOnlineGame(game);
    else emitRoom(game);
  });

  // Oda sahibi boş koltukları botlarla doldurup oyunu başlatabilir.
  socket.on("fillWithBots", () => {
    const game = getGame();
    const me = getMe(game);
    if (!game || !me || game.mode !== "online") return;
    if (game.hostId !== me.id) return socket.emit("errorMessage", "Bunu sadece oda sahibi yapabilir.");
    if (game.started) return;

    let i = 0;
    while (game.players.length < 4) {
      const usedNames = new Set(game.players.map(p => p.name));
      while (usedNames.has(BOT_NAMES[i])) i++;
      game.players.push(makePlayer({ name: BOT_NAMES[i] || `Bot ${i + 1}`, isBot: true }));
    }
    game.log.push("🤖 Boş koltuklar botlarla dolduruldu.");
    startOnlineGame(game);
  });

  socket.on("rematch", () => {
    const game = getGame();
    const me = getMe(game);
    if (!game || !me || !game.gameOver) return;
    if (game.mode === "online" && game.hostId !== me.id) {
      return socket.emit("errorMessage", "Rövanşı oda sahibi başlatır.");
    }
    resetForRematch(game);
  });

  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket);
    socket.emit("left");
  });

  socket.on("playCard", ({ cardId } = {}) => {
    const game = getGame();
    const me = getMe(game);
    if (!game || !me) return;

    const result = playCard(game, me.id, String(cardId || ""));
    if (!result.ok) return socket.emit("errorMessage", result.error);

    afterPlay(game, result);
  });

  socket.on("peskirDecision", ({ accept } = {}) => {
    const game = getGame();
    const me = getMe(game);
    if (!game || !me) return;

    const result = applyPeskirDecision(game, me.id, Boolean(accept));
    if (!result.ok) return socket.emit("errorMessage", result.error);

    onPeskirChanged(game);
  });

  socket.on("disconnect", () => {
    const game = getGame();
    const player = getMe(game);
    if (!game || !player || player.socketId !== socket.id) return;

    if (!game.started) {
      // Lobide: kısa süre içinde dönmezse yeri boşaltılır.
      player.connected = false;
      player.disconnectedAt = Date.now();
      emitRoom(game);
      setTimeout(() => {
        if (!game.started && !player.connected && rooms.get(game.roomCode) === game) {
          removeFromLobby(game, player);
        }
      }, LOBBY_LEAVE_MS);
      return;
    }

    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();

    if (game.mode === "online" && !game.gameOver) {
      game.log.push(`📴 ${player.name} bağlantıyı kesti. ${AWAY_GRACE_MS / 1000} sn içinde dönebilir.`);
    }
    emitRoom(game);
    scheduleCleanupIfEmpty(game);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Maça Kızı: http://localhost:${PORT}`);
});
