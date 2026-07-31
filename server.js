const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const tmi = require('tmi.js');

const PORT = process.env.PORT || 3000;
const BOT_USERNAME = process.env.BOT_USERNAME;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!BOT_USERNAME || !BOT_TOKEN || !CLIENT_ID) {
    console.error('❌ Ошибка: не все переменные окружения заданы');
    process.exit(1);
}

console.log(`🤖 Бот ${BOT_USERNAME} запускается...`);

const app = express();
app.use(cors()); // разрешаем все запросы
app.use(express.json());

// === Health check ===
app.get('/health', (req, res) => {
    res.json({ status: 'ok', bot: BOT_USERNAME });
});

// === Раздача статики (если нужно) ===
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
});

// === Хранилища ===
const clients = {};
const botStatus = {};

function connectBot(channel) {
    const entry = clients[channel];
    if (!entry) return;
    const { client } = entry;

    if (client.readyState === 'OPEN') {
        console.log(`ℹ️ Бот уже в #${channel}`);
        botStatus[channel] = true;
        io.to(channel).emit('bot_status_changed', { channel, active: true });
        return;
    }

    client.connect()
        .then(() => {
            console.log(`✅ Бот ${BOT_USERNAME} подключился к #${channel}`);
            botStatus[channel] = true;
            io.to(channel).emit('bot_status_changed', { channel, active: true });
        })
        .catch(err => {
            console.error(`❌ Ошибка подключения к #${channel}:`, err.message);
            botStatus[channel] = false;
            io.to(channel).emit('bot_status_changed', { channel, active: false });
        });
}

io.on('connection', (socket) => {
    console.log('🔌 Новый клиент подключился к WebSocket');

    socket.on('auth', async ({ channel, token }) => {
        console.log(`🔑 Получен auth для канала ${channel}`);
        if (!channel || !token) {
            socket.emit('auth_error', 'Не указан канал или токен');
            return;
        }

        if (clients[channel]) {
            socket.join(channel);
            socket.emit('auth_success', { channel, message: 'Уже авторизованы' });
            const entry = clients[channel];
            if (entry.client.readyState !== 'OPEN') {
                connectBot(channel);
            } else {
                botStatus[channel] = true;
                io.to(channel).emit('bot_status_changed', { channel, active: true });
            }
            return;
        }

        try {
            const client = new tmi.Client({
                options: { debug: false },
                identity: {
                    username: BOT_USERNAME,
                    password: BOT_TOKEN
                },
                channels: [channel]
            });

            clients[channel] = { client };
            socket.join(channel);
            socket.emit('auth_success', { channel, message: 'Авторизация успешна' });

            // Автоматически подключаем бота
            connectBot(channel);

            client.on('message', (chan, tags, message, self) => {
                if (self) return;
                const user = tags['display-name'] || tags.username;
                const msg = message.trim();
                io.to(channel).emit('chatMessage', { channel, user, message: msg });

                if (msg.startsWith('!')) {
                    const cmd = msg.split(' ')[0].toLowerCase();
                    if (cmd === '!ping') {
                        client.say(channel, `@${user}, pong! 🏓`).catch(err => console.error('Ошибка отправки:', err));
                    }
                }
            });

            client.on('disconnected', () => {
                console.log(`⚠️ Бот отключился от #${channel}`);
                botStatus[channel] = false;
                io.to(channel).emit('bot_status_changed', { channel, active: false });
            });

        } catch (err) {
            console.error('❌ Ошибка в auth:', err.message);
            socket.emit('auth_error', `Ошибка: ${err.message}`);
        }
    });

    socket.on('set_bot_status', ({ channel, active }) => {
        console.log(`🔄 set_bot_status: канал ${channel}, активность ${active}`);
        if (!channel) return;
        botStatus[channel] = active;
        if (active) {
            connectBot(channel);
        } else {
            if (clients[channel] && clients[channel].client.readyState === 'OPEN') {
                clients[channel].client.disconnect();
                console.log(`⛔ Бот отключён от #${channel}`);
            }
            io.to(channel).emit('bot_status_changed', { channel, active: false });
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 Клиент отключился от WebSocket');
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`🤖 Бот ${BOT_USERNAME} готов к подключению`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});