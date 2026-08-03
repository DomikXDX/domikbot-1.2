const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const tmi = require('tmi.js');

const path = require('path');
const PORT = process.env.PORT || 5000;
const AUTO_CHANNEL = (process.env.CHANNEL || 'domik_xdx').toLowerCase();
const BOT_USERNAME = process.env.BOT_USERNAME;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!BOT_USERNAME || !BOT_TOKEN || !CLIENT_ID) {
    console.error('❌ Ошибка: не все переменные окружения заданы');
    process.exit(1);
}

console.log(`🤖 Бот ${BOT_USERNAME} запускается...`);

const app = express();
app.use(cors());
app.use(express.json());
// Отключаем кеш для HTML-файлов, чтобы изменения сразу применялись
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    next();
});

// Приложения, убранные из хаба — блокируем отдачу файлов, даже если они
// физически остались в проекте (например, скачаны отдельным zip-архивом).
// Список путей можно расширять по мере удаления новых приложений.
const RETIRED_APP_PATHS = [
    '/clicker.html', '/coinflip.html', '/gartic.html',
    '/slovotron.html', '/polethudec.html'
];
app.use((req, res, next) => {
    if (RETIRED_APP_PATHS.includes(req.path.toLowerCase())) {
        return res.status(404).send('Приложение больше не доступно.');
    }
    next();
});

app.use(express.static(path.join(__dirname)));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', bot: BOT_USERNAME });
});

app.get('/api/status/:channel', (req, res) => {
    const channel = req.params.channel.toLowerCase();
    const active = !!(clients[channel] && botStatus[channel]);
    res.json({ channel, active, bot: BOT_USERNAME });
});

// ===== Хранилище конфигов пользователей =====
// Railway: храним конфиги в локальном JSON-файле. Файловая система Railway
// эфемерна между передеплоями, поэтому чтобы данные не терялись, подключите
// Volume и укажите путь к нему в переменной окружения CONFIGS_PATH
// (например /data/configs.json). Если CONFIGS_PATH не задан — используется
// файл рядом с проектом (подходит для разработки, но не переживёт передеплой
// без volume).
const fs = require('fs');
const CONFIGS_FILE = process.env.CONFIGS_PATH || './configs.json';
let userConfigs = {};

async function loadAllConfigs() {
    try {
        userConfigs = JSON.parse(fs.readFileSync(CONFIGS_FILE, 'utf8'));
        console.log(`💾 Конфиги загружены из ${CONFIGS_FILE}`);
    } catch (e) {
        console.log(`📝 ${CONFIGS_FILE} не найден, начну с пустого хранилища`);
    }
}

async function persistUserConfig(user, config) {
    userConfigs[user] = config;
    try {
        fs.writeFileSync(CONFIGS_FILE, JSON.stringify(userConfigs, null, 2));
        console.log(`✅ Конфиг ${user} сохранён в ${CONFIGS_FILE}`);
    } catch (err) {
        console.error(`❌ Ошибка сохранения конфига для ${user}:`, err.message);
        throw new Error('Не удалось сохранить конфиг: ' + err.message);
    }
}

app.get('/api/config', (req, res) => {
    const user = (req.query.user || '').toLowerCase();
    if (!user) return res.status(400).json({ error: 'user required' });
    res.json(userConfigs[user] || { commands: {}, announcements: [], interval: 10 });
});

app.post('/api/config', async (req, res) => {
    const user = (req.query.user || '').toLowerCase();
    if (!user) return res.status(400).json({ error: 'user required' });
    try {
        await persistUserConfig(user, req.body);
        res.json({ ok: true });
    } catch (err) {
        console.error(`❌ Не удалось сохранить конфиг для ${user}:`, err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
});

const clients = {};
const botStatus = {};

// Учёт задержек (кулдаунов) по командам — в памяти, сбрасывается при
// перезапуске сервера, что вполне ок для антиспам-задержек.
// lastGlobalUse: Map<commandId, timestampMs>
// lastUserUse:   Map<commandId+'|'+username, timestampMs>
const lastGlobalUse = new Map();
const lastUserUse = new Map();

function isCommandAllowed(cmd, tags, channel) {
    const username = (tags.username || '').toLowerCase();
    const isBroadcaster = username === channel || (tags.badges && tags.badges.broadcaster === '1');
    if (isBroadcaster) return true;

    const personal = (cmd.personalAccess || []).map(u => u.toLowerCase());
    if (personal.includes(username)) return true;

    const perms = cmd.permissions || {};
    // Если явных ограничений не задано вовсе — считаем, что команда открыта всем
    // (иначе только что созданная команда без единой галочки была бы бесполезна).
    const hasAnyRestriction = perms.everyone || perms.mods || perms.vip || perms.subs || personal.length > 0;
    if (!hasAnyRestriction) return true;

    if (perms.everyone) return true;
    if (perms.mods && (tags.mod || (tags.badges && tags.badges.moderator === '1'))) return true;
    if (perms.vip && tags.badges && tags.badges.vip === '1') return true;
    if (perms.subs && tags.subscriber) return true;

    return false;
}

function isOnCooldown(cmd, tags, channel) {
    const isMod = tags.mod || (tags.badges && (tags.badges.moderator === '1' || tags.badges.broadcaster === '1'));
    if (cmd.skipDelayForMods && isMod) return false;

    const now = Date.now();
    if (cmd.globalDelaySec > 0) {
        const last = lastGlobalUse.get(cmd.id) || 0;
        if (now - last < cmd.globalDelaySec * 1000) return true;
    }
    if (cmd.delaySec > 0) {
        const key = cmd.id + '|' + (tags.username || '').toLowerCase();
        const last = lastUserUse.get(key) || 0;
        if (now - last < cmd.delaySec * 1000) return true;
    }
    return false;
}

function markCommandUsed(cmd, tags) {
    const now = Date.now();
    lastGlobalUse.set(cmd.id, now);
    lastUserUse.set(cmd.id + '|' + (tags.username || '').toLowerCase(), now);
}

function sendCommandResponse(client, channel, cmd, tags) {
    // FIX: Проверяем, что клиент подключён перед отправкой
    if (client.readyState !== 'OPEN') {
        console.warn(`⚠️ Клиент не подключён (state: ${client.readyState}), команда ${cmd.prefix} не отправлена в #${channel}`);
        return;
    }

    const response = cmd.response;
    if (cmd.reply && tags.id) {
        // Ответ как реплай на сообщение — тонкая функция tmi.js, поэтому
        // подстраховываемся обычным say(), если raw-отправка не удалась.
        client.raw(`@reply-parent-msg-id=${tags.id} PRIVMSG #${channel} :${response}`)
            .catch(() => client.say(channel, response).catch(err => console.error('Ошибка отправки:', err)));
    } else {
        client.say(channel, response).catch(err => console.error('Ошибка отправки:', err));
    }
}

// Общая обработка команд чата: сперва встроенные (!ping), затем
// пользовательские команды, добавленные в панели (userConfigs[channel].commands —
// МАССИВ объектов с полем .prefix, именно так их сохраняет панель управления).
function handleChatCommand(client, channel, tags, msg) {
    const user = tags['display-name'] || tags.username;
    const firstWord = msg.split(' ')[0].toLowerCase();

    if (msg.startsWith('!') && firstWord === '!ping') {
        client.say(channel, `@${user}, pong! 🏓`).catch(err => console.error('Ошибка отправки:', err));
        return;
    }

    const stored = userConfigs[channel] && userConfigs[channel].commands;
    if (!stored) return;

    // Старый формат (на случай не мигрированных данных): { "!имя": "текст ответа" }.
    if (!Array.isArray(stored)) {
        if (msg.startsWith('!') && Object.prototype.hasOwnProperty.call(stored, firstWord)) {
            client.say(channel, stored[firstWord]).catch(err => console.error('Ошибка отправки:', err));
        }
        return;
    }

    const isReplyMsg = !!tags['reply-parent-msg-id'];

    for (const cmd of stored) {
        if (!cmd.active) continue;
        if (isReplyMsg && !cmd.triggerOnReplies) continue;

        const triggers = [cmd.prefix, ...(cmd.altCommands || [])].filter(Boolean).map(t => t.toLowerCase());
        const matchedByCommand = msg.startsWith('!') && triggers.includes(firstWord);
        const lowerMsg = msg.toLowerCase();
        const matchedByKeyword = (cmd.keywords || []).some(k => k && lowerMsg.includes(k.toLowerCase()));

        if (!matchedByCommand && !matchedByKeyword) continue;
        if (!isCommandAllowed(cmd, tags, channel)) continue;
        if (isOnCooldown(cmd, tags, channel)) continue;

        markCommandUsed(cmd, tags);
        sendCommandResponse(client, channel, cmd, tags);
    }
}

// ✅ НОВОЕ: Функция для инициализации обработчиков сообщений
// Вешается ОДИН РАЗ и никогда не дублируется
function setupMessageHandlers(client, channel) {
    // ✅ НОВОЕ: Проверяем, что обработчик ещё не вешали
    if (client._messageHandlerSetup) {
        console.log(`ℹ️ Обработчик сообщений уже установлен для #${channel}`);
        return;
    }
    client._messageHandlerSetup = true;

    client.on('message', (chan, tags, message, self) => {
        if (self) return;
        const user = tags['display-name'] || tags.username;
        const msg = message.trim();
        
        // ✅ НОВОЕ: Логируем для отладки дублирования
        console.log(`💬 Сообщение от ${user} в #${channel}: "${msg.substring(0, 50)}..."`);
        
        // ✅ УЛУЧШЕНИЕ: Проверяем, что сообщение пришло из правильного канала
        if (chan !== `#${channel}`) {
            console.warn(`⚠️ Сообщение из другого канала: ${chan} != #${channel}`);
            return;
        }
        
        io.to(channel).emit('chatMessage', { channel, user, message: msg });
        handleChatCommand(client, channel, tags, msg);
    });

    console.log(`✅ Обработчик сообщений установлен для #${channel}`);
}

// Создаёт tmi.Client для канала и вешает обработчики РОВНО ОДИН РАЗ.
// Используется и при автоподключении на старте, и при подключении через
// панель/виджет — раньше это дублировалось в трёх местах, из-за чего было
// легко случайно навесить обработчики дважды.
function ensureClient(channel) {
    if (clients[channel]) {
        console.log(`ℹ️ Клиент уже существует для #${channel}`);
        return clients[channel].client;
    }

    const client = new tmi.Client({
        options: { debug: false },
        // FIX: Реконнектом занимается наш собственный код (connectBot), поэтому
        // встроенный автореконнект tmi.js отключаем — иначе оба механизма
        // одновременно пытаются переподключиться к Twitch на одном аккаунте
        // бота, IRC-сервер видит повторный логин и рвёт соединение, отсюда
        // бесконечный цикл "подключился/отключился".
        // timeout увеличен с дефолтных ~10с до 45с: на Replit при простое
        // хостинг иногда придерживает CPU/сеть на доли секунды, и короткий
        // таймаут пинга Twitch ловил это как "Ping timeout" и рвал связь.
        connection: { reconnect: false, timeout: 45000 },
        identity: { username: BOT_USERNAME, password: BOT_TOKEN },
        channels: [channel]
    });
    clients[channel] = { 
        client, 
        connecting: false, 
        shouldReconnect: true, 
        reconnectTimer: null,
        handlersSetup: false  // ✅ НОВОЕ: флаг для отслеживания установки обработчиков
    };

    client.on('disconnected', (reason) => {
        console.log(`⚠️ Бот отключился от #${channel}${reason ? ' (' + reason + ')' : ''}`);
        botStatus[channel] = false;
        io.to(channel).emit('bot_status_changed', { channel, active: false });

        const entry = clients[channel];
        // Переподключаемся сами только если бота явно не выключали (see
        // set_bot_status/widget_set_bot с active:false), и только один раз —
        // без этой защиты каждый "disconnected" плодил бы новую цепочку таймеров.
        if (entry && entry.shouldReconnect && !entry.reconnectTimer) {
            // FIX: Увеличил задержку с 1500ms до 3000ms — Twitch может не одобрить быстрый повторный логин
            entry.reconnectTimer = setTimeout(() => {
                entry.reconnectTimer = null;
                if (entry.shouldReconnect) connectBot(channel);
            }, 3000);
        }
    });

    return client;
}

function connectBot(channel) {
    const entry = clients[channel];
    if (!entry) return;

    // FIX: Не переподключаемся, если уже подключены
    if (entry.client.readyState === 'OPEN') {
        botStatus[channel] = true;
        io.to(channel).emit('bot_status_changed', { channel, active: true });
        console.log(`ℹ️ Бот уже подключён к #${channel}`);
        
        // ✅ НОВОЕ: Установим обработчики если ещё не установлены
        if (!entry.handlersSetup) {
            setupMessageHandlers(entry.client, channel);
            entry.handlersSetup = true;
        }
        return;
    }

    entry.shouldReconnect = true;
    const { client } = entry;
    if (entry.connecting) {
        console.log(`ℹ️ Подключение уже идёт к #${channel}`);
        return; // подключение уже идёт — не дублируем
    }
    entry.connecting = true;
    client.connect()
        .then(() => {
            console.log(`✅ Бот ${BOT_USERNAME} подключился к #${channel}`);
            botStatus[channel] = true;
            io.to(channel).emit('bot_status_changed', { channel, active: true });
            
            // ✅ НОВОЕ: Установим обработчики при успешном подключении
            setupMessageHandlers(client, channel);
            entry.handlersSetup = true;
        })
        .catch(err => {
            console.error(`❌ Ошибка подключения к #${channel}:`, err.message);
            botStatus[channel] = false;
            io.to(channel).emit('bot_status_changed', { channel, active: false });
        })
        .finally(() => {
            entry.connecting = false;
        });
}

// Явное отключение бота пользователем — останавливаем и самолечение реконнектом
function disableBot(channel) {
    const entry = clients[channel];
    if (!entry) return;
    entry.shouldReconnect = false;
    if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = null;
    }
    if (entry.client.readyState === 'OPEN') {
        entry.client.disconnect();
    }
    botStatus[channel] = false;
    io.to(channel).emit('bot_status_changed', { channel, active: false });
}

io.on('connection', (socket) => {
    console.log('🔌 Новый клиент подключился к WebSocket');

    socket.on('auth', async ({ channel, token }) => {
        if (!channel || !token) {
            socket.emit('auth_error', 'Не указан канал или токен');
            return;
        }
        channel = channel.toLowerCase();
        try {
            const isNew = !clients[channel];
            ensureClient(channel);
            socket.join(channel);
            socket.emit('auth_success', { channel, message: isNew ? 'Авторизация успешна' : 'Уже авторизованы' });
            connectBot(channel);
        } catch (err) {
            console.error('❌ Ошибка в auth:', err.message);
            socket.emit('auth_error', `Ошибка: ${err.message}`);
        }
    });

    socket.on('set_bot_status', ({ channel, active }) => {
        if (!channel) return;
        channel = channel.toLowerCase();
        if (active) {
            ensureClient(channel);
            connectBot(channel);
        } else {
            disableBot(channel);
        }
    });

    // Виджет: подключиться к комнате канала и получить текущий статус
    socket.on('widget_join', ({ channel }) => {
        if (!channel) return;
        const ch = channel.toLowerCase();
        socket.join(ch);
        const active = !!(clients[ch] && botStatus[ch]);
        socket.emit('widget_state', { channel: ch, active });
    });

    // Виджет: включить/выключить бота для канала
    socket.on('widget_set_bot', ({ channel, active }) => {
        if (!channel) return;
        const ch = channel.toLowerCase();
        if (active) {
            ensureClient(ch);
            connectBot(ch);
        } else {
            disableBot(ch);
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 Клиент отключился от WebSocket');
    });
});

// Самопинг для Replit больше не нужен: Railway не усыпляет запущенный сервис,
// поэтому весь блок keep-alive убран.

async function startServer() {
    await loadAllConfigs();

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Сервер запущен на порту ${PORT}`);
        console.log(`🤖 Бот ${BOT_USERNAME} готов к подключению`);
        console.log(`🔗 Health check: http://localhost:${PORT}/health`);
        console.log(`💾 Конфиги хранятся в: ${CONFIGS_FILE}`);

        // Автоподключение к каналу при старте сервера
        botStatus[AUTO_CHANNEL] = false;
        ensureClient(AUTO_CHANNEL);
        connectBot(AUTO_CHANNEL);
    });
}

startServer();

// ===== Graceful shutdown =====
// При передеплое Replit сначала стартует НОВЫЙ процесс и только потом шлёт
// SIGTERM старому — какое-то время оба держат логин бота в Twitch одним и тем
// же аккаунтом, и IRC начинает поочерёдно "выкидывать" то один, то другой
// (отсюда серии "Ping timeout"/"Unable to connect." сразу после деплоя). Явно
// отключаем все tmi-клиенты, как только приходит сигнал остановки, — старый
// процесс отпускает логин быстрее, окно двойного коннекта короче.
function shutdown(signal) {
    console.log(`🛑 Получен ${signal}, отключаю бота от всех каналов...`);
    for (const channel of Object.keys(clients)) {
        const entry = clients[channel];
        entry.shouldReconnect = false;
        if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
        try {
            if (entry.client.readyState === 'OPEN') entry.client.disconnect();
        } catch (e) {}
    }
    setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
