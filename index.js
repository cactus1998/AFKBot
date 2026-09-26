require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, ChannelType, Events } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState, createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior, AudioPlayerStatus } = require('@discordjs/voice');
const { Readable } = require('stream');

class Silence extends Readable {
    _read() {
        this.push(Buffer.from([0xf8, 0xff, 0xfe]));
    }
}
const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

// 看門狗檢查間隔，與語音連線卡住多久就強制重連
const WATCHDOG_INTERVAL_MS = 30_000;
const VOICE_STUCK_CHECKS = 4; // 連續 4 次 (約 2 分鐘) 不是 Ready 就重連
// Discord Gateway 斷線超過此時間就讓程式結束，交給 Render 重新啟動
const GATEWAY_DOWN_EXIT_MS = 5 * 60_000;

// 讀取儲存的頻道資料
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('讀取 data.json 失敗:', error.message);
    }
    return {};
}

// 儲存頻道資料
function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 目前應該掛在哪些頻道 (guildId -> channelId)，看門狗依此自動補連
const targets = new Map();
// 正在等待重連的伺服器，避免看門狗重複加入
const reconnecting = new Set();
// 語音連線連續不是 Ready 的次數
const notReadyCounts = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages, // 加入發送訊息的 intent
    ],
});

// 檢查所有目標頻道是否都已連線
function getHealth() {
    const problems = [];
    if (!client.isReady()) {
        problems.push('Discord gateway not ready');
    }
    for (const [guildId, channelId] of targets) {
        const connection = getVoiceConnection(guildId);
        if (!connection) {
            problems.push(`guild ${guildId}: no voice connection`);
        } else if (connection.state.status !== VoiceConnectionStatus.Ready) {
            problems.push(`guild ${guildId}: voice ${connection.state.status}`);
        } else if (connection.joinConfig.channelId !== channelId) {
            problems.push(`guild ${guildId}: in wrong channel`);
        }
    }
    return problems;
}

// =========================================================
// 建立一個簡單的網頁伺服器
// 機器人或語音連線異常時回傳 503，讓 cron-job.org 能發現並通知
const server = http.createServer((req, res) => {
    const problems = getHealth();
    if (problems.length === 0) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bot is running and alive!');
    } else {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Bot unhealthy:\n${problems.join('\n')}`);
    }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`喚醒用網頁伺服器已啟動於 port ${PORT}`);
});
// =========================================================

const commands = [
    new SlashCommandBuilder()
        .setName('join')
        .setDescription('讓機器人加入指定的語音頻道並掛機 (僅限管理員)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('選擇要加入的語音頻道')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildVoice)
        ),
    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('讓機器人離開目前的語音頻道 (僅限管理員)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

function safeDestroy(connection) {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
    }
}

// 處理語音連線與斷線重連邏輯
function connectToChannel(channel) {
    const guildId = channel.guild.id;

    // 先清掉舊連線，避免重複掛上監聽器與播放器
    const existing = getVoiceConnection(guildId);
    if (existing) {
        safeDestroy(existing);
    }
    notReadyCounts.delete(guildId);

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
    });

    // 捕捉連線錯誤 (例如 522 Timeout)，避免直接導致程式崩潰 (Exit status 1)
    connection.on('error', (error) => {
        console.error(`[語音連線發生錯誤] 頻道 ${channel.name}:`, error.message);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            // 等待一下看是否能自動重連 (例如伺服器切換)
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch (error) {
            console.log(`[中斷連線] 嘗試重新連接 ${channel.name}...`);

            // 若為真正斷線，必須先銷毀原本的無效連線，否則無法重連！
            safeDestroy(connection);

            if (targets.get(guildId) !== channel.id) return;

            reconnecting.add(guildId);
            // 如果真的斷開離開了，發送被強迫離開的提示訊息
            try {
                await channel.send('⚠️ **機器人已被強迫離開頻道 (可能因 Discord 閒置或網路中斷)！** 正在嘗試自動重連...');
            } catch (e) {
                console.error('無法發送離開訊息:', e.message);
            }

            // 延遲 2 秒後再次強制加入
            setTimeout(() => {
                reconnecting.delete(guildId);
                ensureConnected(guildId);
            }, 2000);
        }
    });

    // 播放無聲音訊，防止 Discord 因為閒置過久而自動踢除機器人
    const player = createAudioPlayer({
        behaviors: {
            noSubscriber: NoSubscriberBehavior.Play,
        },
    });
    let stopped = false;

    // 建立無聲音訊資源並播放
    const playSilence = () => {
        const resource = createAudioResource(new Silence(), { inputType: StreamType.Opus });
        player.play(resource);
    };

    player.on('stateChange', (oldState, newState) => {
        // 當播放結束或變為 idle 時，自動重新播放無聲音訊
        if (newState.status === AudioPlayerStatus.Idle && !stopped) {
            playSilence();
        }
    });

    player.on('error', error => {
        console.error('Audio player error:', error.message);
    });

    // 連線銷毀時一併停掉播放器，否則每次重連都會留下一個空轉的播放器
    connection.on(VoiceConnectionStatus.Destroyed, () => {
        stopped = true;
        player.stop(true);
    });

    connection.subscribe(player);
    playSilence();

    return connection;
}

// 確保指定伺服器的機器人在目標頻道中，不在就重新加入
async function ensureConnected(guildId) {
    const channelId = targets.get(guildId);
    if (!channelId || reconnecting.has(guildId)) return;

    const connection = getVoiceConnection(guildId);
    if (connection && connection.joinConfig.channelId === channelId) {
        if (connection.state.status === VoiceConnectionStatus.Ready) {
            notReadyCounts.delete(guildId);
            return;
        }
        // 可能正在重連中，給它一點時間，卡太久才強制重來
        const count = (notReadyCounts.get(guildId) || 0) + 1;
        notReadyCounts.set(guildId, count);
        if (count < VOICE_STUCK_CHECKS) return;
        console.log(`[看門狗] 語音連線卡在 ${connection.state.status} 太久，強制重連`);
    }

    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isVoiceBased()) {
            console.error(`[看門狗] 找不到語音頻道 ${channelId}`);
            return;
        }
        connectToChannel(channel);
        console.log(`🔄 [看門狗] 已重新加入語音頻道：${channel.name}`);
    } catch (err) {
        console.error(`[看門狗] 重新加入頻道失敗 (${channelId}):`, err.message);
    }
}

// 看門狗：定期檢查 Gateway 與語音連線，斷了就自動補回
let lastGatewayReadyAt = Date.now();
setInterval(() => {
    if (!client.isReady()) {
        const downFor = Date.now() - lastGatewayReadyAt;
        console.log(`[看門狗] Discord Gateway 未就緒 (${Math.round(downFor / 1000)} 秒)`);
        if (downFor > GATEWAY_DOWN_EXIT_MS) {
            console.error('[看門狗] Gateway 斷線過久，結束程式交給 Render 重啟');
            process.exit(1);
        }
        return;
    }
    lastGatewayReadyAt = Date.now();
    for (const guildId of targets.keys()) {
        ensureConnected(guildId);
    }
}, WATCHDOG_INTERVAL_MS);

client.once(Events.ClientReady, async (c) => {
    console.log(`已成功登入為 ${c.user.tag}!`);
    console.log(`語音掛機機器人已啟動。`);

    // 設定機器人狀態與版本號
    const BOT_VERSION = '1.1';
    c.user.setActivity(`掛機專用 浪漫開發 v${BOT_VERSION}`);

    try {
        console.log('正在為伺服器註冊斜線指令 (/) ...');
        for (const guild of client.guilds.cache.values()) {
            await guild.commands.set(commands);
        }
        console.log('✅ 斜線指令註冊完成！');
    } catch (error) {
        console.error('註冊斜線指令時發生錯誤:', error);
    }

    // 備用方案：讀取本地 data.json (但在 Render 會被刪除)
    const data = loadData();
    for (const guildId in data) {
        targets.set(guildId, data[guildId]);
    }

    // 如果有在 Render 設定環境變數，絕對不會被刪除！
    const envChannelId = process.env.VOICE_CHANNEL_ID;
    if (envChannelId) {
        try {
            const channel = await client.channels.fetch(envChannelId);
            if (channel && channel.isVoiceBased()) {
                targets.set(channel.guild.id, channel.id);
            }
        } catch (err) {
            console.error(`無法透過環境變數取得頻道 (${envChannelId}):`, err);
        }
    }

    // 自動重連先前儲存的頻道
    for (const guildId of targets.keys()) {
        await ensureConnected(guildId);
    }
});

client.on(Events.GuildCreate, async (guild) => {
    try {
        await guild.commands.set(commands);
        console.log(`已自動在伺服器 ${guild.name} 註冊指令。`);
    } catch (error) {
        console.error(`在伺服器 ${guild.name} 註冊指令失敗:`, error);
    }
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'join') {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ 只有管理員可以使用這個指令！', ephemeral: true });
        }

        const voiceChannel = interaction.options.getChannel('channel');

        try {
            targets.set(voiceChannel.guild.id, voiceChannel.id);
            connectToChannel(voiceChannel);

            // 儲存頻道資料
            const data = loadData();
            data[voiceChannel.guild.id] = voiceChannel.id;
            saveData(data);

            await interaction.reply(`✅ 已成功加入語音頻道：**${voiceChannel.name}**，我將會一直掛在這裡。`);
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: '加入語音頻道時發生錯誤。', ephemeral: true });
        }
    }

    if (interaction.commandName === 'leave') {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ 只有管理員可以使用這個指令！', ephemeral: true });
        }

        // 從目標移除，看門狗才不會再把機器人拉回去
        targets.delete(interaction.guildId);
        const connection = getVoiceConnection(interaction.guildId);

        // 刪除紀錄
        const data = loadData();
        if (data[interaction.guildId]) {
            delete data[interaction.guildId];
            saveData(data);
        }

        if (!connection) {
            return interaction.reply({ content: '我目前不在任何語音頻道中！', ephemeral: true });
        }

        safeDestroy(connection);
        await interaction.reply('✅ 已退出語音頻道。');
    }
});

// Gateway 狀態紀錄，方便從 Render log 追查斷線原因
client.on(Events.Error, (error) => {
    console.error('[Discord client 錯誤]', error);
});
client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`[Gateway 斷線] shard ${shardId} code=${event.code}`);
});
client.on(Events.ShardReconnecting, (shardId) => {
    console.warn(`[Gateway 重連中] shard ${shardId}`);
});
client.on(Events.ShardResume, (shardId) => {
    console.log(`[Gateway 已恢復] shard ${shardId}`);
});

// 未處理的錯誤一律記錄下來，避免無聲無息地掛掉
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (error) => {
    console.error('[uncaughtException]', error);
    // 狀態可能已損壞，結束程式交給 Render 重新啟動
    process.exit(1);
});

// 捕捉 Render 強制關機的訊號 (SIGTERM)
process.on('SIGTERM', async () => {
    console.log('接收到 Render 的關機訊號，準備關閉...');
    const envChannelId = process.env.VOICE_CHANNEL_ID;
    if (envChannelId) {
        try {
            const channel = await client.channels.fetch(envChannelId);
            if (channel) {
                await channel.send('⚠️ **主機 (Render) 進入強制休眠，機器人被迫斷線！** 等待喚醒中...');
            }
        } catch (e) {
            console.error(e);
        }
    }
    process.exit(0);
});

client.login(process.env.TOKEN);
