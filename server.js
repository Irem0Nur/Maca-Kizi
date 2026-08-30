import express from "express";
import http from "http";
import { Server } from "socket.io";
import { createGame, playCard, startBotGame, chooseBotCard, resolveTrick, legalCards, applyPeskirDecision } from "./src/game.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();
const botTimers = new Map();
const turnTimers = new Map();

const TURN_SECONDS = 20;

function publicState(game, viewerId) {
  return {
    mode: game.mode,
    roomCode: game.roomCode,
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
      isBot: p.isBot
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
    if (p.socketId) {
      io.to(p.socketId).emit("state", publicState(game, p.id));
    }
  }
}


function clearTurnTimer(roomCode) {
  const timer = turnTimers.get(roomCode);
  if (timer) clearTimeout(timer);
  turnTimers.delete(roomCode);
}

function chooseTimeoutCard(game, player) {
  const legal = legalCards(game, player);
  if (!legal.length) return null;

  // Süre bitince mümkün olan en düşük kart otomatik oynanır.
  return [...legal].sort((a, b) => a.value - b.value)[0];
}

function startTurnTimer(game) {
  clearTurnTimer(game.roomCode);

  if (
    game.gameOver ||
    game.waitingPeskir ||
    game.trickResolving ||
    !game.currentPlayer
  ) {
    game.turnDeadline = null;
    return;
  }

  const currentId = game.currentPlayer;
  game.turnDeadline = Date.now() + TURN_SECONDS * 1000;
  emitRoom(game);

  const timer = setTimeout(() => {
    if (
      game.gameOver ||
      game.waitingPeskir ||
      game.trickResolving ||
      game.currentPlayer !== currentId
    ) return;

    const player = game.players.find(p => p.id === currentId);
    if (!player) return;

    const card = chooseTimeoutCard(game, player);
    if (!card) return;

    game.log.push(`⏱️ ${player.name} süresini doldurdu. ${card.id} otomatik atıldı.`);

    const result = playCard(game, player.id, card.id);
    emitRoom(game);

    if (result.trickComplete) {
      scheduleTrickResolution(game, 1300);
    } else {
      scheduleBotTurn(game, 900);
      startTurnTimer(game);
    }
  }, TURN_SECONDS * 1000);

  turnTimers.set(game.roomCode, timer);
}

function clearBotTimer(roomCode) {
  const timer = botTimers.get(roomCode);
  if (timer) clearTimeout(timer);
  botTimers.delete(roomCode);
}

function scheduleTrickResolution(game, delay = 1300) {
  setTimeout(() => {
    if (!game.trickResolving || game.gameOver) return;

    resolveTrick(game);
    emitRoom(game);

    // Son el yeni turu başlattıysa yeni turdaki bot Peşkir cevaplarını sırayla göster.
    if (game.waitingPeskir) {
      resolveBotPeskirs(game, 5500);
    } else {
      scheduleBotTurn(game, 900);
      startTurnTimer(game);
    }
  }, delay);
}



function resolveBotPeskirs(game, delay = 650) {
  if (!game.waitingPeskir || game.gameOver) return;

  const pendingBotIds = (game.pendingPeskir || []).filter(id => {
    const p = game.players.find(x => x.id === id);
    return p?.isBot;
  });

  pendingBotIds.forEach((botId, index) => {
    setTimeout(() => {
      if (!game.waitingPeskir || !game.pendingPeskir.includes(botId)) return;

      // Botlar Peşkir ilanını EVET olarak cevaplar.
      applyPeskirDecision(game, botId, true);
      emitRoom(game);

      if (!game.waitingPeskir && !game.gameOver) {
        scheduleBotTurn(game, 900);
        startTurnTimer(game);
      }
    }, delay + index * 450);
  });
}

function scheduleBotTurn(game, delay = 900) {
  clearBotTimer(game.roomCode);

  if (game.mode !== "bot" || game.gameOver || game.trickResolving || game.waitingPeskir) return;

  const current = game.players.find(p => p.id === game.currentPlayer);
  if (!current?.isBot) return;

  const timer = setTimeout(() => {
    if (game.gameOver) return;

    const bot = game.players.find(p => p.id === game.currentPlayer);
    if (!bot?.isBot) return;

    const card = chooseBotCard(game, bot);
    if (!card) return;

    const result = playCard(game, bot.id, card.id);
    emitRoom(game);

    clearTurnTimer(game.roomCode);

    if (result.trickComplete) {
      // Dördüncü kart 1.3 saniye masada kalsın.
      game.turnDeadline = null;
      scheduleTrickResolution(game, 1300);
    } else {
      scheduleBotTurn(game, 900);
      startTurnTimer(game);
    }
  }, delay);

  botTimers.set(game.roomCode, timer);
}

io.on("connection", socket => {
  socket.on("botGame", ({ name }) => {
    const game = startBotGame(socket.id, name || "Oyuncu");
    rooms.set(game.roomCode, game);
    socket.join(game.roomCode);

    socket.emit("joined", {
      roomCode: game.roomCode,
      playerId: socket.id
    });

    // Önce insan oyuncuya Peşkir penceresini gösterecek state'i gönder.
    emitRoom(game);

    // Bot cevapları daha sonra masada görünür şekilde gelsin.
    resolveBotPeskirs(game, 5500);

    if (!game.waitingPeskir) {
      scheduleBotTurn(game, 1100);
      startTurnTimer(game);
    }
  });

  socket.on("createRoom", ({ name }) => {
    let code;

    do {
      code = Math.random().toString(36).slice(2,8).toUpperCase();
    } while (rooms.has(code));

    const game = createGame("online", code);

    game.players.push({
      id: socket.id,
      socketId: socket.id,
      name: name || "Oyuncu 1",
      hand: [],
      penalty: 0,
      kafa: 0,
      tricksWon: 0,
      isBot: false
    });

    rooms.set(code, game);
    socket.join(code);

    socket.emit("joined", {
      roomCode: code,
      playerId: socket.id
    });

    emitRoom(game);
  });

  socket.on("joinRoom", ({ roomCode, name }) => {
    const code = (roomCode || "").trim().toUpperCase();
    const game = rooms.get(code);

    if (!game) return socket.emit("errorMessage", "Oda bulunamadı.");
    if (game.players.length >= 4) return socket.emit("errorMessage", "Oda dolu.");

    game.players.push({
      id: socket.id,
      socketId: socket.id,
      name: name || `Oyuncu ${game.players.length + 1}`,
      hand: [],
      penalty: 0,
      kafa: 0,
      tricksWon: 0,
      isBot: false
    });

    socket.join(code);

    socket.emit("joined", {
      roomCode: code,
      playerId: socket.id
    });

    if (game.players.length === 4) {
      game.startRound();
      resolveBotPeskirs(game);
    }

    emitRoom(game);

    if (game.players.length === 4 && !game.waitingPeskir) {
      startTurnTimer(game);
    }
  });

  socket.on("playCard", ({ roomCode, cardId }) => {
    const game = rooms.get(roomCode);
    if (!game) return;

    const result = playCard(game, socket.id, cardId);

    if (!result.ok) {
      return socket.emit("errorMessage", result.error);
    }

    clearTurnTimer(game.roomCode);
    emitRoom(game);

    if (result.trickComplete) {
      game.turnDeadline = null;
      scheduleTrickResolution(game, 1300);
    } else {
      scheduleBotTurn(game, 950);
      startTurnTimer(game);
    }
  });


  socket.on("peskirDecision", ({ roomCode, accept }) => {
    const game = rooms.get(roomCode);
    if (!game) return;

    const result = applyPeskirDecision(game, socket.id, Boolean(accept));

    if (!result.ok) {
      return socket.emit("errorMessage", result.error);
    }

    emitRoom(game);

    if (!game.waitingPeskir && !game.gameOver) {
      scheduleBotTurn(game, 900);
      startTurnTimer(game);
    }
  });

  socket.on("disconnect", () => {
    for (const game of rooms.values()) {
      const player = game.players.find(p => p.socketId === socket.id);

      if (player && game.mode === "online") {
        game.log.push(`${player.name} bağlantıyı kesti.`);
        emitRoom(game);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Maça Kızı: http://localhost:${PORT}`);
});
