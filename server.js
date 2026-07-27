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
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling']
});

// Простой API для проверки
app.get('/health', (req, res) => {
    res.json({ status: 'ok', bot: BOT_USERNAME });
});

// Хранилище
const clients = {};
const botStatus = {};

// Подключение бота
function connectBot(channel) {
    const entry = clients[channel];
    if (!entry) return;
    const { client } = entry;

    if (client.readyState === 'OPEN') {
        console.log(`ℹ️ Бот уже в #${channel}`);
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

// WebSocket
io.on('connection', (socket) => {
    console.log('🔌 Клиент подключился');

    socket.on('auth', ({ channel, token }) => {
        if (!channel) {
            socket.emit('auth_error', 'Не указан канал');
            return;
        }

        if (clients[channel]) {
            socket.join(channel);
            socket.emit('auth_success', { channel, message: 'Уже подключены' });
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
            socket.emit('bot_status_changed', { channel, active: false });

            console.log(`🔑 Авторизован канал #${channel}`);

            // Обработка сообщений
            client.on('message', (chan, tags, message, self) => {
                if (self) return;
                const user = tags['display-name'] || tags.username;
                const msg = message.trim();

                io.to(channel).emit('chatMessage', { channel, user, message: msg });

                if (msg.startsWith('!')) {
                    const cmd = msg.split(' ')[0].toLowerCase();
                    if (cmd === '!ping') {
                        client.say(channel, `@${user}, pong! 🏓`);
                    }
                }
            });

            client.on('disconnected', () => {
                console.log(`⚠️ Бот отключился от #${channel}`);
                botStatus[channel] = false;
                io.to(channel).emit('bot_status_changed', { channel, active: false });
            });

        } catch (err) {
            console.error('Ошибка:', err.message);
            socket.emit('auth_error', `Ошибка: ${err.message}`);
        }
    });

    socket.on('set_bot_status', ({ channel, active }) => {
        if (!channel) return;
        botStatus[channel] = active;
        if (active) {
            connectBot(channel);
        } else {
            if (clients[channel] && clients[channel].client.readyState === 'OPEN') {
                clients[channel].client.disconnect();
            }
            io.to(channel).emit('bot_status_changed', { channel, active: false });
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 Клиент отключился');
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`🤖 Бот ${BOT_USERNAME} готов к подключению`);
});