const SUITS = ["C", "D", "S", "H"];
const RANKS = [
  ["2",2],["3",3],["4",4],["5",5],["6",6],["7",7],["8",8],["9",9],
  ["10",10],["J",11],["Q",12],["K",13],["A",14]
];

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const [rank, value] of RANKS) {
      deck.push({ id: `${rank}${suit}`, suit, rank, value });
    }
  }
  return deck;
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function cardPenalty(card) {
  if (card.id === "QS") return 15;
  if (card.id === "AH") return 5;
  if (card.id === "KH") return 4;
  if (card.suit === "H") return 1;
  return 0;
}

export function legalCards(game, player) {
  const hand = player.hand;

  // Eli oyuncu başlatıyorsa:
  // Sinek 2 sadece ilk başlayacak kişiyi belirler.
  // Sinek 2'yi atma zorunluluğu YOK.
  if (!game.leadSuit) {
    // Kupa kırılmadan kupa ile başlanamaz.
    if (!game.heartsBroken) {
      const nonHearts = hand.filter(c => c.suit !== "H");
      if (nonHearts.length) return nonHearts;
    }
    return hand;
  }

  // Açılan tür takip edilir.
  const sameSuit = hand.filter(c => c.suit === game.leadSuit);
  if (sameSuit.length) return sameSuit;

  // Açılan tür yoksa zorunlu sıra:
  // Q♠ -> A♥ -> K♥ -> herhangi kupa -> başka kart
  const qSpades = hand.find(c => c.id === "QS");
  if (qSpades) return [qSpades];

  const aHearts = hand.find(c => c.id === "AH");
  if (aHearts) return [aHearts];

  const kHearts = hand.find(c => c.id === "KH");
  if (kHearts) return [kHearts];

  const hearts = hand.filter(c => c.suit === "H");
  if (hearts.length) return hearts;

  return hand;
}

function determineLosers(game) {
  return game.players.filter(p => p.kafa >= 5 || p.penalty >= 180);
}

function finishTrick(game) {
  const leadSuit = game.leadSuit;

  const eligible = game.trick
    .filter(t => t.card.suit === leadSuit)
    .sort((a, b) => b.card.value - a.card.value);

  const winnerId = eligible[0].playerId;
  const winner = game.players.find(p => p.id === winnerId);

  winner.tricksWon += 1;

  const trickPenalty = game.trick.reduce(
    (sum, t) => sum + cardPenalty(t.card), 0
  );

  winner.roundPenalty += trickPenalty;

  game.log.push(
    `${winner.name} eli aldı${trickPenalty ? ` (+${trickPenalty} ceza)` : ""}.`
  );

  game.trick = [];
  game.leadSuit = null;
  game.currentPlayer = winnerId;

  const cardsLeft = game.players.reduce(
    (sum, p) => sum + p.hand.length, 0
  );

  if (cardsLeft === 0) finishRound(game);
}



function finishRound(game) {
  const shooter = game.players.find(p => p.roundPenalty === 35);

  // Kafa varsa o tur Peşkir uygulanmaz.
  if (shooter) {
    shooter.kafa += 1;

    for (const p of game.players) {
      if (p.id !== shooter.id) p.penalty += 35;
    }

    game.log.push(`💥 ${shooter.name} KAFA attı! Diğer oyuncular +35 ceza aldı.`);
    finalizeRound(game);
    return;
  }

  // Normal tur cezaları önce eklenir.
  for (const p of game.players) {
    p.penalty += p.roundPenalty;
  }

  // Tur başında Peşkir ilan eden oyuncu gerçekten hiç el almadıysa -35.
  for (const p of game.players) {
    const declared = Boolean(game.peskirDeclarations?.[p.id]);

    if (!declared) continue;

    if (p.tricksWon === 0 && p.penalty >= 35) {
      p.penalty -= 35;
      game.log.push(`🧣 ${p.name} Peşkir'i BAŞARDI! -35 ceza.`);
    } else if (p.tricksWon > 0) {
      game.log.push(`❌ ${p.name} Peşkir'i BOZDU; bu tur el aldı.`);
    } else {
      game.log.push(`❌ ${p.name} hiç el almadı fakat 35 cezası olmadığı için Peşkir indirimi uygulanmadı.`);
    }
  }

  finalizeRound(game);
}

function finalizeRound(game) {
  game.waitingPeskir = false;
  game.pendingPeskir = [];

  const losers = determineLosers(game);

  if (losers.length) {
    game.gameOver = true;
    game.loserIds = losers.map(p => p.id);
    game.loserId = losers[0].id;

    for (const p of losers) {
      let reason = "";
      if (p.kafa >= 5 && p.penalty >= 180) reason = "5 Kafa ve 180+ ceza";
      else if (p.kafa >= 5) reason = "5 Kafa";
      else reason = "180+ ceza";

      game.log.push(`☠️ ${p.name} oyunu kaybetti: ${reason}.`);
    }

    return;
  }

  game.round += 1;
  game.startRound();
}

export function applyPeskirDecision(game, playerId, accept) {
  if (!game.waitingPeskir) {
    return { ok:false, error:"Şu anda Peşkir kararı beklenmiyor." };
  }

  if (!game.pendingPeskir.includes(playerId)) {
    return { ok:false, error:"Bu oyuncunun Peşkir kararı beklenmiyor." };
  }

  const player = game.players.find(p => p.id === playerId);
  if (!player) return { ok:false, error:"Oyuncu bulunamadı." };

  game.peskirDeclarations[playerId] = Boolean(accept);
  game.peskirAnswers[playerId] = accept ? "EVET" : "HAYIR";

  if (accept) {
    game.log.push(`🧣 ${player.name}: "PEŞKİR ATIYORUM!"`);
  } else {
    game.log.push(`${player.name}: "Peşkir atmıyorum."`);
  }

  game.pendingPeskir = game.pendingPeskir.filter(id => id !== playerId);

  if (!game.pendingPeskir.length) {
    game.waitingPeskir = false;
    game.log.push("Peşkir kararları tamamlandı. Oyun başlıyor.");
  }

  return { ok:true };
}

export function createGame(mode, roomCode) {
  const game = {
    mode,
    roomCode,
    players: [],
    currentPlayer: null,
    leadSuit: null,
    heartsBroken: false,
    trick: [],
    trickResolving: false,
    round: 1,
    gameOver: false,
    loserId: null,
    loserIds: [],
    pendingPeskir: [],
    waitingPeskir: false,
    peskirDeclarations: {},
    peskirAnswers: {},
    log: [],

    startRound() {
      if (this.players.length !== 4 || this.gameOver) return;

      const deck = shuffle(makeDeck());

      for (const p of this.players) {
        p.hand = [];
        p.roundPenalty = 0;
        p.tricksWon = 0;
      }

      deck.forEach((card, i) => {
        this.players[i % 4].hand.push(card);
      });

      for (const p of this.players) {
        p.hand.sort((a, b) =>
          SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) ||
          a.value - b.value
        );
      }

      // Sinek 2 sadece ilk oyuncuyu belirler.
      const starter = this.players.find(
        p => p.hand.some(c => c.id === "2C")
      );

      this.currentPlayer = starter.id;
      this.leadSuit = null;
      this.heartsBroken = false;
      this.trick = [];
      this.trickResolving = false;

      this.peskirDeclarations = {};
      this.peskirAnswers = {};

      // Peşkir kararı kartlar dağıtılır dağıtılmaz HER oyuncuya sorulur.
      // -35 uygulaması ise tur sonunda Peşkir şartları gerçekten oluşmuşsa yapılır.
      this.pendingPeskir = this.players.map(p => p.id);
      this.waitingPeskir = true;

      this.log.push(
        `Tur ${this.round} başladı. Sinek 2 ${starter.name} oyuncusunda; ilk hamle onda.`
      );

      if (this.waitingPeskir) {
        const names = this.players
          .filter(p => this.pendingPeskir.includes(p.id))
          .map(p => p.name)
          .join(", ");
        this.log.push(`🧣 Kartlar dağıtıldı. Peşkir kararları bekleniyor: ${names}.`);
      }
    }
  };

  return game;
}

export function startBotGame(humanId, name) {
  const code = `BOT-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
  const game = createGame("bot", code);

  game.players = [
    { id: humanId, socketId: humanId, name, hand: [], penalty: 0, kafa: 0, tricksWon: 0, isBot: false },
    { id: `bot1-${code}`, name: "Bot 1", hand: [], penalty: 0, kafa: 0, tricksWon: 0, isBot: true },
    { id: `bot2-${code}`, name: "Bot 2", hand: [], penalty: 0, kafa: 0, tricksWon: 0, isBot: true },
    { id: `bot3-${code}`, name: "Bot 3", hand: [], penalty: 0, kafa: 0, tricksWon: 0, isBot: true }
  ];

  game.startRound();
  return game;
}

export function playCard(game, playerId, cardId) {
  if (game.waitingPeskir) {
    return { ok:false, error:"Peşkir kararı bekleniyor." };
  }

  if (game.trickResolving) {
    return { ok: false, error: "El sonucu hesaplanıyor." };
  }

  if (game.gameOver) {
    return { ok: false, error: "Oyun bitti." };
  }

  if (game.currentPlayer !== playerId) {
    return { ok: false, error: "Sıra sende değil." };
  }

  const player = game.players.find(p => p.id === playerId);
  if (!player) {
    return { ok: false, error: "Oyuncu bulunamadı." };
  }

  const card = player.hand.find(c => c.id === cardId);
  if (!card) {
    return { ok: false, error: "Kart bulunamadı." };
  }

  const validCards = legalCards(game, player);

  if (!validCards.some(c => c.id === card.id)) {
    return { ok: false, error: "Bu kartı şu anda oynayamazsın." };
  }

  player.hand = player.hand.filter(c => c.id !== card.id);

  if (!game.leadSuit) game.leadSuit = card.suit;
  if (card.suit === "H") game.heartsBroken = true;

  game.trick.push({ playerId, card });
  game.log.push(`${player.name}: ${card.id}`);

  if (game.trick.length === 4) {
    // Dördüncü kart hemen kaybolmasın.
    // Sunucu kısa bir süre sonra resolveTrick() çağıracak.
    game.trickResolving = true;
    game.currentPlayer = null;
  } else {
    const index = game.players.findIndex(p => p.id === playerId);
    game.currentPlayer = game.players[(index + 1) % 4].id;
  }

  return { ok: true, trickComplete: game.trick.length === 4 };
}

export function resolveTrick(game) {
  if (!game.trickResolving || game.trick.length !== 4) return false;

  game.trickResolving = false;
  finishTrick(game);
  return true;
}

export function chooseBotCard(game, bot) {
  const valid = legalCards(game, bot);
  if (!valid.length) return null;

  return [...valid].sort((a, b) => a.value - b.value)[0];
}
