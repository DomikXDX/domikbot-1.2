require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const tmi = require('tmi.js');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const BOT_USERNAME = process.env.BOT_USERNAME;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!BOT_USERNAME || !BOT_TOKEN || !CLIENT_ID) {
    console.error('❌ Ошибка: не все переменные окружения заданы в .env');
    process.exit(1);
}

// ===== ХРАНИЛИЩА =====
const configs = {};
const clients = {};
const botStatus = {};
const battles = {};
const giveaways = {};
const wheelGames = {};
const guessGames = {};

const STATUS_FILE = './bot_status.json';
function loadStatus() {
    try {
        Object.assign(botStatus, JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')));
    } catch (e) {}
}
function saveStatus() {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(botStatus));
}
loadStatus();

// ===== EXPRESS =====
const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

// ===== API =====
app.get('/api/config', (req, res) => {
    const channel = req.query.user;
    if (!channel) return res.status(400).json({ error: 'Missing user' });
    res.json(configs[channel] || { commands: {}, announcements: [], interval: 10 });
});

app.post('/api/config', (req, res) => {
    const channel = req.query.user;
    if (!channel) return res.status(400).json({ error: 'Missing user' });
    configs[channel] = req.body;
    res.json({ success: true });
});

// ===== ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ БЕЗОПАСНОЙ ОТПРАВКИ =====
function safeSay(client, channel, message) {
    if (client && client.readyState === 'OPEN') {
        client.say(channel, message).catch(err => {
            console.error(`Ошибка отправки сообщения в ${channel}:`, err);
        });
    } else {
        console.warn(`⚠️ Не удалось отправить сообщение в ${channel}: клиент не подключен`);
    }
}

// ============================================================
//  SONG BATTLE (ТУРНИРНАЯ СИСТЕМА)
// ============================================================
function sanitizeBattle(battle) {
    if (!battle) return null;
    return {
        stage: battle.stage,
        theme: battle.theme || '',
        maxSongs: battle.maxSongs || 16,
        perUser: battle.perUser || 1,
        songs: (battle.songs || []).map(s => ({
            id: s.id,
            title: s.title,
            url: s.url,
            addedBy: s.addedBy,
            timestamp: s.timestamp
        })),
        pairs: (battle.pairs || []).map(p => ({
            song1: { id: p.song1.id, title: p.song1.title, url: p.song1.url, addedBy: p.song1.addedBy },
            song2: { id: p.song2.id, title: p.song2.title, url: p.song2.url, addedBy: p.song2.addedBy },
            votes1: p.votes1 || 0,
            votes2: p.votes2 || 0,
            voters: p.voters || [],
            winner: p.winner ? { id: p.winner.id, title: p.winner.title, url: p.winner.url, addedBy: p.winner.addedBy } : null
        })),
        currentPairIndex: battle.currentPairIndex || 0,
        winner: battle.winner ? { id: battle.winner.id, title: battle.winner.title, url: battle.winner.url, addedBy: battle.winner.addedBy } : null,
        startedAt: battle.startedAt || null,
        round: battle.round || 1
    };
}

function getBattle(channel) {
    if (!battles[channel]) {
        battles[channel] = {
            stage: 'idle',
            theme: '',
            maxSongs: 16,
            perUser: 1,
            songs: [],
            pairs: [],
            currentPairIndex: 0,
            votes: {},
            timer: null,
            startedAt: null,
            winner: null,
            round: 1
        };
    }
    return battles[channel];
}

function resetBattle(channel) {
    const battle = getBattle(channel);
    battle.stage = 'idle';
    battle.songs = [];
    battle.pairs = [];
    battle.currentPairIndex = 0;
    battle.votes = {};
    battle.winner = null;
    battle.round = 1;
    if (battle.timer) clearInterval(battle.timer);
    battle.timer = null;
}

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function advanceToNextPairOrRound(channel) {
    const battle = getBattle(channel);
    if (battle.stage !== 'voting') return;

    const currentPair = battle.pairs[battle.currentPairIndex];
    if (!currentPair) return;

    if (!currentPair.winner) {
        if (currentPair.votes1 > currentPair.votes2) {
            currentPair.winner = currentPair.song1;
        } else if (currentPair.votes2 > currentPair.votes1) {
            currentPair.winner = currentPair.song2;
        } else {
            currentPair.winner = Math.random() < 0.5 ? currentPair.song1 : currentPair.song2;
        }
    }

    battle.currentPairIndex++;

    if (battle.currentPairIndex >= battle.pairs.length) {
        const winners = battle.pairs.map(p => p.winner).filter(w => w !== null);
        if (winners.length === 0) {
            battle.stage = 'finished';
            if (battle.timer) clearInterval(battle.timer);
            io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
            return;
        }

        if (winners.length === 1) {
            battle.winner = winners[0];
            battle.stage = 'finished';
            if (battle.timer) clearInterval(battle.timer);
            io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
            const client = clients[channel]?.client;
            safeSay(client, channel, `🏆 Победитель баттла: ${battle.winner.title}!`);
            return;
        }

        const shuffledWinners = shuffleArray(winners);
        const newPairs = [];
        for (let i = 0; i < shuffledWinners.length; i += 2) {
            if (i + 1 < shuffledWinners.length) {
                newPairs.push({
                    song1: shuffledWinners[i],
                    song2: shuffledWinners[i+1],
                    votes1: 0,
                    votes2: 0,
                    voters: [],
                    winner: null
                });
            } else {
                const byeSong = { id: 'bye', title: 'Bye', addedBy: 'system', url: '' };
                newPairs.push({
                    song1: shuffledWinners[i],
                    song2: byeSong,
                    votes1: 0,
                    votes2: 0,
                    voters: [],
                    winner: null
                });
            }
        }

        battle.pairs = newPairs;
        battle.currentPairIndex = 0;
        battle.round = (battle.round || 0) + 1;

        if (battle.timer) clearInterval(battle.timer);
        let timeLeft = 30;
        battle.timer = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                clearInterval(battle.timer);
                advanceToNextPairOrRound(channel);
            }
            io.to(channel).emit('battle_timer', { channel, timeLeft });
        }, 1000);
        io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
    } else {
        if (battle.timer) clearInterval(battle.timer);
        let timeLeft = 30;
        battle.timer = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                clearInterval(battle.timer);
                advanceToNextPairOrRound(channel);
            }
            io.to(channel).emit('battle_timer', { channel, timeLeft });
        }, 1000);
        io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
    }
}

// ============================================================
//  ПОЛЕ ЧУДЕС
// ============================================================
function getWheelGame(channel) {
    if (!wheelGames[channel]) {
        wheelGames[channel] = {
            stage: 'idle',
            word: '',
            hint: '',
            players: [],
            scores: {},
            currentPlayerIndex: 0,
            lettersGuessed: [],
            wrongAttempts: 0,
            maxAttempts: 6,
            spinValue: 0,
            turnTimer: null,
            collected: false,
            wordLength: 0,
            guessedLetters: new Set()
        };
    }
    return wheelGames[channel];
}

function resetWheelGame(channel) {
    const game = getWheelGame(channel);
    game.stage = 'idle';
    game.word = '';
    game.hint = '';
    game.players = [];
    game.scores = {};
    game.currentPlayerIndex = 0;
    game.lettersGuessed = [];
    game.wrongAttempts = 0;
    game.spinValue = 0;
    game.guessedLetters = new Set();
    if (game.turnTimer) clearInterval(game.turnTimer);
    game.turnTimer = null;
    game.collected = false;
    game.wordLength = 0;
}

function emitWheelState(channel) {
    const game = getWheelGame(channel);
    const state = {
        stage: game.stage,
        word: game.word,
        hint: game.hint,
        players: game.players,
        scores: game.scores,
        currentPlayerIndex: game.currentPlayerIndex,
        lettersGuessed: game.lettersGuessed,
        wrongAttempts: game.wrongAttempts,
        maxAttempts: game.maxAttempts,
        spinValue: game.spinValue,
        collected: game.collected,
        wordLength: game.wordLength,
        guessedLetters: game.guessedLetters
    };
    io.to(channel).emit('wheel_state', { channel, state });
}

function nextWheelPlayer(channel) {
    const game = getWheelGame(channel);
    if (game.players.length === 0) return;
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
    game.collected = false;
    if (game.turnTimer) clearInterval(game.turnTimer);
    game.turnTimer = null;
    emitWheelState(channel);
}

// ============================================================
//  GUESS THE WORD (СЛОВАРЬ)
// ============================================================
const WORD_DICT = {
    animals: ['кошка', 'собака', 'кот', 'медведь', 'лиса', 'волк', 'заяц', 'орёл', 'дельфин', 'акула', 'лев', 'тигр', 'слон', 'жираф', 'пингвин', 'крокодил', 'обезьяна', 'попугай', 'черепаха', 'хомяк'],
    food: ['банан', 'яблоко', 'пицца', 'мороженое', 'шоколад', 'кофе', 'чай', 'молоко', 'хлеб', 'торт', 'гамбургер', 'картошка', 'суши', 'борщ', 'пельмени', 'блины', 'сосиска', 'сыр', 'арбуз', 'виноград'],
    things: ['телефон', 'компьютер', 'гитара', 'пианино', 'клавиатура', 'мышка', 'монитор', 'наушники', 'микрофон', 'камера', 'принтер', 'книга', 'ручка', 'стол', 'стул', 'окно', 'дверь', 'лампа', 'часы', 'зеркало'],
    nature: ['солнце', 'луна', 'дерево', 'огонь', 'вода', 'земля', 'воздух', 'снег', 'дождь', 'радуга', 'гроза', 'ветер', 'облако', 'гора', 'море', 'река', 'пустыня', 'вулкан', 'цветок', 'лес'],
    transport: ['машина', 'ракета', 'самолёт', 'корабль', 'велосипед', 'поезд', 'автобус', 'вертолёт', 'лодка', 'мотоцикл', 'трамвай', 'метро', 'скутер', 'яхта', 'такси'],
    sports: ['футбол', 'баскетбол', 'хоккей', 'теннис', 'бокс', 'плавание', 'шахматы', 'скейтборд', 'волейбол', 'гольф', 'сноуборд', 'лыжи', 'карате', 'бег', 'йога'],
    twitch: ['стример', 'донат', 'подписчик', 'модератор', 'эмоут', 'чат', 'фолловер', 'рейд', 'бан', 'клип', 'хайп', 'контент', 'стрим', 'камера', 'микрофон'],
    fantasy: ['пират', 'ниндзя', 'рыцарь', 'зомби', 'вампир', 'робот', 'инопланетянин', 'дракон', 'единорог', 'эльф', 'гном', 'маг', 'ведьма', 'призрак', 'демон'],
    movies: ['Титаник', 'Аватар', 'Матрица', 'Шрек', 'Джокер', 'Бэтмен', 'Халк', 'Тор', 'Спайдермен', 'Гарри Поттер', 'Властелин колец', 'Терминатор', 'Пила', 'Крик', 'Маска'],
    music: ['гитара', 'барабан', 'пианино', 'скрипка', 'саксофон', 'флейта', 'микрофон', 'наушники', 'концерт', 'рок', 'рэп', 'джаз', 'диджей', 'бит', 'бас'],
    jobs: ['учитель', 'врач', 'повар', 'пожарный', 'полицейский', 'космонавт', 'программист', 'художник', 'актёр', 'музыкант', 'пилот', 'водитель', 'строитель', 'ветеринар', 'фермер']
};

function getGuessGame(channel) {
    if (!guessGames[channel]) {
        guessGames[channel] = {
            stage: 'idle',
            word: '',
            category: 'all',
            rounds: 5,
            currentRound: 0,
            score: 0,
            attempts: 0,
            maxAttempts: 3,
            showTime: 3,
            usedWords: [],
            wordList: [],
            status: '',
            timer: null,
            showTimer: null
        };
    }
    return guessGames[channel];
}

function resetGuessGame(channel) {
    const game = getGuessGame(channel);
    game.stage = 'idle';
    game.word = '';
    game.currentRound = 0;
    game.score = 0;
    game.attempts = 0;
    game.usedWords = [];
    game.wordList = [];
    if (game.timer) clearInterval(game.timer);
    if (game.showTimer) clearTimeout(game.showTimer);
    game.timer = null;
    game.showTimer = null;
}

function pickWord(category, usedWords) {
    let pool = [];
    if (category === 'all') {
        for (let cat in WORD_DICT) pool = pool.concat(WORD_DICT[cat]);
    } else {
        pool = WORD_DICT[category] || [];
    }
    const available = pool.filter(w => !usedWords.includes(w));
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
}

function nextGuessWord(channel) {
    const game = getGuessGame(channel);
    if (game.currentRound >= game.rounds) {
        game.stage = 'finished';
        io.to(channel).emit('guess_finished', { channel, score: game.score, total: game.rounds });
        const client = clients[channel]?.client;
        safeSay(client, channel, `🏁 Игра окончена! Очки: ${game.score}/${game.rounds}`);
        return;
    }
    const word = pickWord(game.category, game.usedWords);
    if (!word) {
        io.to(channel).emit('guess_error', 'Слова закончились!');
        game.stage = 'finished';
        return;
    }
    game.word = word;
    game.usedWords.push(word);
    game.currentRound++;
    game.stage = 'show_word';
    io.to(channel).emit('guess_word_show', { channel, word: game.word, round: game.currentRound, total: game.rounds, time: game.showTime });
    if (game.showTimer) clearTimeout(game.showTimer);
    game.showTimer = setTimeout(() => {
        game.stage = 'playing';
        game.attempts = 0;
        io.to(channel).emit('guess_word_playing', { channel, round: game.currentRound, total: game.rounds, score: game.score, attempts: game.attempts, maxAttempts: game.maxAttempts });
        const client = clients[channel]?.client;
        safeSay(client, channel, '🔄 Чат, описывайте слово! Не называйте его!');
    }, game.showTime * 1000);
}

// ============================================================
//  ПОДКЛЮЧЕНИЕ БОТА
// ============================================================
function connectBot(channel) {
    const entry = clients[channel];
    if (!entry) return;
    const { client } = entry;
    if (client.readyState === 'OPEN') return;
    client.connect().then(() => {
        console.log(`✅ Бот ${BOT_USERNAME} подключился к #${channel}`);
        botStatus[channel] = true;
        saveStatus();
        io.to(channel).emit('bot_status_changed', { channel, active: true });
    }).catch(err => {
        console.error(`❌ Ошибка подключения к #${channel}:`, err);
        botStatus[channel] = false;
        saveStatus();
        io.to(channel).emit('bot_status_changed', { channel, active: false });
    });
}

function disconnectBot(channel) {
    const entry = clients[channel];
    if (entry && entry.client.readyState === 'OPEN') entry.client.disconnect();
    botStatus[channel] = false;
    saveStatus();
    io.to(channel).emit('bot_status_changed', { channel, active: false });
}

// ============================================================
//  ОБРАБОТЧИК СОКЕТОВ
// ============================================================
io.on('connection', (socket) => {
    console.log('🔌 Новый клиент подключился');

    socket.on('auth', async ({ channel, token }) => {
        if (!channel || !token) {
            socket.emit('auth_error', 'Не указан канал или токен');
            return;
        }
        if (clients[channel]) {
            clients[channel].token = token;
            socket.join(channel);
            socket.emit('auth_success', { channel, message: 'Токен обновлён' });
            socket.emit('bot_status_changed', { channel, active: botStatus[channel] || false });
            if (botStatus[channel]) connectBot(channel);
            return;
        }
        try {
            const client = new tmi.Client({
                options: { debug: false },
                identity: { username: BOT_USERNAME, password: BOT_TOKEN },
                channels: [channel]
            });
            clients[channel] = { client, token };
            socket.join(channel);
            const isActive = botStatus[channel] || false;
            socket.emit('auth_success', { channel, message: 'Авторизация успешна' });
            socket.emit('bot_status_changed', { channel, active: isActive });
            console.log(`🔑 Авторизован канал #${channel}, бот ${BOT_USERNAME}`);

            client.on('message', (chan, tags, message, self) => {
                if (self) return;
                const user = tags['display-name'] || tags.username;
                const msg = message.trim();

                io.to(channel).emit('chatMessage', { channel, user, message: msg });

                // ===== КОМАНДЫ =====
                const config = configs[channel] || { commands: {} };
                const commands = config.commands || {};
                if (msg.startsWith('!')) {
                    const cmd = msg.split(' ')[0].toLowerCase();
                    const response = commands[cmd];
                    if (response) {
                        safeSay(client, channel, `@${user}, ${response}`);
                    }
                }

                // ===== SONG BATTLE =====
                const battle = getBattle(channel);
                if (msg.startsWith('!song ') && battle.stage === 'collecting') {
                    const url = msg.slice(6).trim();
                    if (url) {
                        if (battle.songs.some(s => s.url === url)) {
                            safeSay(client, channel, `@${user}, эта песня уже добавлена!`);
                            return;
                        }
                        if (battle.songs.filter(s => s.addedBy === user).length >= battle.perUser) {
                            safeSay(client, channel, `@${user}, ты уже добавил максимум песен (${battle.perUser}).`);
                            return;
                        }
                        if (battle.songs.length >= battle.maxSongs) {
                            safeSay(client, channel, `Достигнут лимит песен (${battle.maxSongs}). Сбор завершён.`);
                            return;
                        }
                        const title = url.length > 30 ? url.slice(0,30)+'...' : url;
                        battle.songs.push({
                            id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
                            title, url, addedBy: user, timestamp: Date.now()
                        });
                        const left = battle.maxSongs - battle.songs.length;
                        safeSay(client, channel, `@${user}, песня добавлена! Осталось слотов: ${left}`);
                        if (left === 0) safeSay(client, channel, `Сбор песен завершён! Все ${battle.maxSongs} слотов заполнены.`);
                        io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
                    }
                    return;
                }
                if (battle.stage === 'voting') {
                    const pair = battle.pairs[battle.currentPairIndex];
                    if (!pair) return;
                    if (pair.voters && pair.voters.includes(user)) return;
                    const choice = parseInt(msg.trim());
                    if (choice === 1) {
                        pair.votes1 = (pair.votes1 || 0) + 1;
                        if (!pair.voters) pair.voters = [];
                        pair.voters.push(user);
                        io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
                        return;
                    } else if (choice === 2) {
                        pair.votes2 = (pair.votes2 || 0) + 1;
                        if (!pair.voters) pair.voters = [];
                        pair.voters.push(user);
                        io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
                        return;
                    }
                }

                // ===== GIVEAWAY =====
                const gv = giveaways[channel];
                if (gv && gv.active && msg.trim().toLowerCase() === gv.keyword.toLowerCase()) {
                    if (!gv.users.has(user)) {
                        gv.users.add(user);
                        const count = gv.users.size;
                        safeSay(client, channel, `@${user}, ты принял участие! Всего участников: ${count}`);
                        io.to(channel).emit('giveaway_update', { channel, users: Array.from(gv.users), count });
                    }
                }

                // ===== ПОЛЕ ЧУДЕС =====
                const wheel = getWheelGame(channel);
                if (msg.toLowerCase() === '!join' && wheel.stage === 'collecting') {
                    if (!wheel.players.includes(user)) {
                        wheel.players.push(user);
                        wheel.scores[user] = 0;
                        safeSay(client, channel, `@${user}, ты в списке!`);
                        emitWheelState(channel);
                    } else {
                        safeSay(client, channel, `@${user}, ты уже участвуешь!`);
                    }
                    return;
                }
                if (msg.toLowerCase() === '!spin' && wheel.stage === 'playing') {
                    const currentPlayer = wheel.players[wheel.currentPlayerIndex];
                    if (user !== currentPlayer) {
                        safeSay(client, channel, `@${user}, сейчас ход ${currentPlayer}!`);
                        return;
                    }
                    const sectors = [0,100,200,300,400,500,0,0,150,250,350,450];
                    const spin = sectors[Math.floor(Math.random() * sectors.length)];
                    wheel.spinValue = spin;
                    safeSay(client, channel, `@${currentPlayer} — выпало ${spin}`);
                    if (spin === 0) {
                        safeSay(client, channel, `⏭️ Ход переходит к следующему игроку!`);
                        nextWheelPlayer(channel);
                    } else {
                        wheel.collected = true;
                        if (wheel.turnTimer) clearInterval(wheel.turnTimer);
                        let timeLeft = 15;
                        wheel.turnTimer = setInterval(() => {
                            timeLeft--;
                            if (timeLeft <= 0) {
                                clearInterval(wheel.turnTimer);
                                safeSay(client, channel, `⏰ Время вышло! Ход переходит.`);
                                wheel.collected = false;
                                nextWheelPlayer(channel);
                            }
                        }, 1000);
                        emitWheelState(channel);
                    }
                    return;
                }
                if (wheel.stage === 'playing' && wheel.collected) {
                    const currentPlayer = wheel.players[wheel.currentPlayerIndex];
                    if (user !== currentPlayer) return;
                    const letter = msg.trim().toUpperCase();
                    if (/^[А-ЯA-Z]$/.test(letter) && letter.length === 1) {
                        if (wheel.guessedLetters.has(letter)) {
                            safeSay(client, channel, `@${user}, буква "${letter}" уже была названа!`);
                            return;
                        }
                        wheel.guessedLetters.add(letter);
                        const wordUpper = wheel.word.toUpperCase();
                        if (wordUpper.includes(letter)) {
                            const count = (wordUpper.match(new RegExp(letter, 'g')) || []).length;
                            const earned = wheel.spinValue * count;
                            wheel.scores[currentPlayer] = (wheel.scores[currentPlayer] || 0) + earned;
                            safeSay(client, channel, `@${currentPlayer}, буква "${letter}" есть! +${earned} очков`);
                            wheel.lettersGuessed.push(letter);
                            const allLetters = wordUpper.split('').filter(ch => ch !== ' ' && ch !== '-' && ch !== '’');
                            const guessedAll = allLetters.every(ch => wheel.guessedLetters.has(ch));
                            if (guessedAll) {
                                safeSay(client, channel, `🎉 Слово отгадано! Победитель: ${currentPlayer}!`);
                                wheel.stage = 'finished';
                                clearInterval(wheel.turnTimer);
                                wheel.collected = false;
                                emitWheelState(channel);
                                return;
                            }
                            emitWheelState(channel);
                        } else {
                            wheel.wrongAttempts++;
                            safeSay(client, channel, `@${currentPlayer}, буквы "${letter}" нет! Ошибок: ${wheel.wrongAttempts}/${wheel.maxAttempts}`);
                            if (wheel.wrongAttempts >= wheel.maxAttempts) {
                                safeSay(client, channel, `💀 Игра окончена! Слово было: ${wheel.word}`);
                                wheel.stage = 'finished';
                                clearInterval(wheel.turnTimer);
                                wheel.collected = false;
                                emitWheelState(channel);
                                return;
                            }
                            nextWheelPlayer(channel);
                            emitWheelState(channel);
                        }
                        return;
                    }
                }
                if (msg.toLowerCase().startsWith('!word ') && wheel.stage === 'playing') {
                    const currentPlayer = wheel.players[wheel.currentPlayerIndex];
                    if (user !== currentPlayer) return;
                    const guess = msg.slice(6).trim().toUpperCase();
                    if (guess === wheel.word.toUpperCase()) {
                        safeSay(client, channel, `🎉 @${currentPlayer} угадал слово! Победитель: ${currentPlayer}!`);
                        wheel.stage = 'finished';
                        clearInterval(wheel.turnTimer);
                        wheel.collected = false;
                        emitWheelState(channel);
                    } else {
                        safeSay(client, channel, `❌ Неправильно! Попробуйте ещё раз.`);
                        wheel.wrongAttempts++;
                        if (wheel.wrongAttempts >= wheel.maxAttempts) {
                            safeSay(client, channel, `💀 Игра окончена! Слово было: ${wheel.word}`);
                            wheel.stage = 'finished';
                            clearInterval(wheel.turnTimer);
                            wheel.collected = false;
                            emitWheelState(channel);
                        } else {
                            nextWheelPlayer(channel);
                            emitWheelState(channel);
                        }
                    }
                    return;
                }

                // ===== GUESS THE WORD =====
                // Всё обрабатывается через сокеты
            });

            client.on('disconnected', () => {
                console.log(`⚠️ Бот отключился от #${channel}`);
                botStatus[channel] = false;
                saveStatus();
                io.to(channel).emit('bot_status_changed', { channel, active: false });
            });

            if (isActive) connectBot(channel);
        } catch (err) {
            console.error(`❌ Ошибка авторизации #${channel}:`, err);
            socket.emit('auth_error', `Ошибка: ${err.message}`);
        }
    });

    // ===== УПРАВЛЕНИЕ СТАТУСОМ БОТА =====
    socket.on('set_bot_status', ({ channel, active }) => {
        if (!channel) return;
        botStatus[channel] = active;
        saveStatus();
        if (active) connectBot(channel);
        else disconnectBot(channel);
        io.to(channel).emit('bot_status_changed', { channel, active });
    });

    // ===== SONG BATTLE =====
    socket.on('get_battle_state', ({ channel }) => {
        const battle = getBattle(channel);
        socket.emit('battle_update', { channel, battle: sanitizeBattle(battle) });
    });
    socket.on('start_collection', ({ channel, theme, maxSongs, perUser }) => {
        const battle = getBattle(channel);
        resetBattle(channel);
        battle.stage = 'collecting';
        battle.theme = theme;
        battle.maxSongs = maxSongs;
        battle.perUser = perUser;
        battle.songs = [];
        io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
    });
    socket.on('stop_collection', ({ channel }) => {
        const battle = getBattle(channel);
        if (battle.stage === 'collecting') {
            battle.stage = 'idle';
            io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
        }
    });
    socket.on('add_song_manual', ({ channel, url }) => {
        const battle = getBattle(channel);
        if (battle.stage !== 'collecting') return;
        if (battle.songs.length >= battle.maxSongs) return;
        if (battle.songs.some(s => s.url === url)) {
            socket.emit('battle_error', 'Эта песня уже добавлена');
            return;
        }
        battle.songs.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
            title: url.length > 30 ? url.slice(0,30)+'...' : url,
            url, addedBy: 'manual', timestamp: Date.now()
        });
        io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
    });
    socket.on('remove_song', ({ channel, index }) => {
        const battle = getBattle(channel);
        if (battle.stage === 'collecting' && index >= 0 && index < battle.songs.length) {
            battle.songs.splice(index, 1);
            io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
        }
    });
    socket.on('start_battle', ({ channel }) => {
        const battle = getBattle(channel);
        if (battle.stage !== 'collecting' || battle.songs.length < 4) return;

        const shuffled = shuffleArray([...battle.songs]);
        let songsForTournament = shuffled;
        if (songsForTournament.length % 2 !== 0) {
            songsForTournament.push({ id: 'bye', title: 'Bye', addedBy: 'system', url: '' });
        }
        const pairs = [];
        for (let i = 0; i < songsForTournament.length; i += 2) {
            pairs.push({
                song1: songsForTournament[i],
                song2: songsForTournament[i+1],
                votes1: 0,
                votes2: 0,
                voters: [],
                winner: null
            });
        }

        battle.pairs = pairs;
        battle.currentPairIndex = 0;
        battle.stage = 'voting';
        battle.startedAt = Date.now();
        battle.round = 1;
        battle.songs = songsForTournament;

        if (battle.timer) clearInterval(battle.timer);
        let timeLeft = 30;
        battle.timer = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                clearInterval(battle.timer);
                advanceToNextPairOrRound(channel);
            }
            io.to(channel).emit('battle_timer', { channel, timeLeft });
        }, 1000);

        io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
    });
    socket.on('skip_pair', ({ channel }) => {
        const battle = getBattle(channel);
        if (battle.stage !== 'voting') return;
        const currentPair = battle.pairs[battle.currentPairIndex];
        if (currentPair) {
            if (currentPair.votes1 === 0 && currentPair.votes2 === 0) {
                currentPair.winner = Math.random() < 0.5 ? currentPair.song1 : currentPair.song2;
            } else {
                currentPair.winner = currentPair.votes1 >= currentPair.votes2 ? currentPair.song1 : currentPair.song2;
            }
        }
        if (battle.timer) clearInterval(battle.timer);
        advanceToNextPairOrRound(channel);
    });
    socket.on('end_battle', ({ channel }) => {
        const battle = getBattle(channel);
        if (battle.stage === 'voting') {
            const currentPair = battle.pairs[battle.currentPairIndex];
            if (currentPair) {
                currentPair.winner = currentPair.votes1 >= currentPair.votes2 ? currentPair.song1 : currentPair.song2;
            }
            const winners = battle.pairs.map(p => p.winner).filter(w => w !== null);
            if (winners.length > 0) {
                battle.winner = winners[0];
            }
            battle.stage = 'finished';
            if (battle.timer) clearInterval(battle.timer);
            io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(battle) });
            const client = clients[channel]?.client;
            safeSay(client, channel, `🏆 Победитель баттла: ${battle.winner ? battle.winner.title : 'не определён'}`);
        }
    });
    socket.on('reset_battle', ({ channel }) => {
        resetBattle(channel);
        io.to(channel).emit('battle_update', { channel, battle: sanitizeBattle(getBattle(channel)) });
    });

    // ===== GIVEAWAY =====
    socket.on('start_giveaway', ({ channel, keyword }) => {
        giveaways[channel] = { keyword, active: true, users: new Set() };
        io.to(channel).emit('giveaway_update', { channel, users: [], count: 0 });
    });
    socket.on('reset_giveaway', ({ channel }) => {
        delete giveaways[channel];
    });

    // ===== ПОЛЕ ЧУДЕС =====
    socket.on('get_wheel_state', ({ channel }) => {
        emitWheelState(channel);
    });
    socket.on('wheel_start_setup', ({ channel, word, hint, maxAttempts }) => {
        const game = getWheelGame(channel);
        resetWheelGame(channel);
        game.stage = 'setup';
        game.word = word.toUpperCase();
        game.hint = hint;
        game.maxAttempts = maxAttempts || 6;
        emitWheelState(channel);
    });
    socket.on('wheel_start_collecting', ({ channel, duration }) => {
        const game = getWheelGame(channel);
        if (game.stage !== 'setup') return;
        game.stage = 'collecting';
        game.players = [];
        game.scores = {};
        game.collected = false;
        const client = clients[channel]?.client;
        safeSay(client, channel, `⚠️ Поле Чудес! Пишите !join чтобы участвовать! (${duration||30} сек)`);
        if (game.turnTimer) clearInterval(game.turnTimer);
        let timeLeft = duration || 30;
        game.turnTimer = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                clearInterval(game.turnTimer);
                game.turnTimer = null;
                if (game.players.length < 2) {
                    const client2 = clients[channel]?.client;
                    safeSay(client2, channel, `Недостаточно игроков (нужно минимум 2). Игра отменена.`);
                    game.stage = 'idle';
                    emitWheelState(channel);
                    return;
                }
                game.players = shuffleArray(game.players);
                game.currentPlayerIndex = 0;
                game.stage = 'playing';
                game.wordLength = game.word.replace(/\s/g, '').length;
                const client3 = clients[channel]?.client;
                safeSay(client3, channel, `⚠️ Игроки выбраны: ${game.players.join(', ')} | Ход: ${game.players[0]} (пиши !spin)`);
                emitWheelState(channel);
            }
            io.to(channel).emit('wheel_timer', { channel, timeLeft });
        }, 1000);
        emitWheelState(channel);
    });
    socket.on('wheel_force_start', ({ channel }) => {
        const game = getWheelGame(channel);
        if (game.stage !== 'collecting' || game.players.length < 2) return;
        if (game.turnTimer) clearInterval(game.turnTimer);
        game.turnTimer = null;
        game.players = shuffleArray(game.players);
        game.currentPlayerIndex = 0;
        game.stage = 'playing';
        game.wordLength = game.word.replace(/\s/g, '').length;
        const client = clients[channel]?.client;
        safeSay(client, channel, `⚠️ Игроки выбраны: ${game.players.join(', ')} | Ход: ${game.players[0]} (пиши !spin)`);
        emitWheelState(channel);
    });
    socket.on('wheel_cancel', ({ channel }) => {
        resetWheelGame(channel);
        emitWheelState(channel);
    });

    // ===== GUESS THE WORD =====
    socket.on('get_guess_state', ({ channel }) => {
        // можно отправить состояние, но пока не требуется
    });
    socket.on('guess_start', ({ channel, category, rounds, showTime }) => {
        const game = getGuessGame(channel);
        resetGuessGame(channel);
        game.category = category || 'all';
        game.rounds = rounds || 5;
        game.showTime = showTime || 3;
        game.maxAttempts = 3;
        game.currentRound = 0;
        game.score = 0;
        game.usedWords = [];
        nextGuessWord(channel);
    });
    socket.on('guess_attempt', ({ channel, guess }) => {
        const game = getGuessGame(channel);
        if (game.stage !== 'playing') return;
        const guessClean = guess.trim().toLowerCase();
        const wordClean = game.word.toLowerCase();
        if (guessClean === wordClean) {
            game.score++;
            game.stage = 'correct';
            io.to(channel).emit('guess_correct', { channel, word: game.word, score: game.score });
            const client = clients[channel]?.client;
            safeSay(client, channel, `✅ Стример угадал! Слово: ${game.word} (попыток: ${game.attempts+1}) 🎉`);
            setTimeout(() => nextGuessWord(channel), 3000);
        } else {
            game.attempts++;
            io.to(channel).emit('guess_wrong', { channel, attempts: game.attempts, maxAttempts: game.maxAttempts });
            if (game.attempts >= game.maxAttempts) {
                const client = clients[channel]?.client;
                safeSay(client, channel, `❌ Стример не угадал! Слово: ${game.word}`);
                setTimeout(() => nextGuessWord(channel), 2000);
            }
        }
    });
    socket.on('guess_giveup', ({ channel }) => {
        const game = getGuessGame(channel);
        if (game.stage !== 'playing') return;
        const client = clients[channel]?.client;
        safeSay(client, channel, `❌ Стример сдался! Слово: ${game.word}`);
        nextGuessWord(channel);
    });
    socket.on('guess_next', ({ channel }) => {
        const game = getGuessGame(channel);
        if (game.stage === 'correct' || game.stage === 'playing') {
            nextGuessWord(channel);
        }
    });
    socket.on('guess_cancel', ({ channel }) => {
        resetGuessGame(channel);
        io.to(channel).emit('guess_cancelled', { channel });
    });

    socket.on('disconnect', () => {
        console.log('🔌 Клиент отключился');
    });
});

// ===== ЗАПУСК =====
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`🤖 Бот ${BOT_USERNAME} готов к подключению к каналам`);
});