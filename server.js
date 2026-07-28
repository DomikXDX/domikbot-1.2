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

// Подключение бота с подробными логами
function connectBot(channel) {
    console.log(`🔌 connectBot вызван для канала ${channel}`);
    const entry = clients[channel];
    if (!entry) {
        console.error(`❌ Нет клиента для ${channel}`);
        return;
    }
    const { client } = entry;

    if (client.readyState === 'OPEN') {
        console.log(`ℹ️ Бот уже в #${channel}, подключение не требуется`);
        botStatus[channel] = true;
        io.to(channel).emit('bot_status_changed', { channel, active: true });
        return;
    }

    console.log(`🔄 Пытаемся подключить бота к #${channel}...`);
    client.connect()
        .then(() => {
            console.log(`✅ Бот ${BOT_USERNAME} успешно подключился к #${channel}`);
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
    console.log('🔌 Новый клиент подключился к WebSocket');

    socket.on('auth', async ({ channel, token }) => {
        console.log(`🔑 Получен auth для канала ${channel}, токен: ${token ? 'есть' : 'нет'}`);
        if (!channel || !token) {
            socket.emit('auth_error', 'Не указан канал или токен');
            return;
        }

        if (clients[channel]) {
            console.log(`ℹ️ Клиент для ${channel} уже существует, обновляем токен`);
            socket.join(channel);
            socket.emit('auth_success', { channel, message: 'Уже авторизованы' });
            // Проверяем, подключён ли бот, если нет – подключаем
            const entry = clients[channel];
            if (entry.client.readyState !== 'OPEN') {
                console.log(`🔄 Клиент не в OPEN, вызываем connectBot для ${channel}`);
                connectBot(channel);
            } else {
                console.log(`✅ Клиент уже в OPEN для ${channel}`);
                botStatus[channel] = true;
                io.to(channel).emit('bot_status_changed', { channel, active: true });
            }
            return;
        }

        try {
            console.log(`🆕 Создаём нового клиента для канала ${channel}`);
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
            console.log(`✅ auth_success отправлен для ${channel}`);

            // === АВТОМАТИЧЕСКОЕ ПОДКЛЮЧЕНИЕ БОТА ===
            console.log(`🔄 Вызываем connectBot для ${channel}`);
            connectBot(channel);

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
            console.error('❌ Ошибка в auth:', err.message);
            socket.emit('auth_error', `Ошибка: ${err.message}`);
        }
    });

    // Обработка ручного включения/выключения (для совместимости)
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

server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`🤖 Бот ${BOT_USERNAME} готов к подключению`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});