require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, ChannelType, Events } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState, createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior } = require('@discordjs/voice');
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

// 讀取儲存的頻道資料
function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
    return {};
}

// 儲存頻道資料
function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// =========================================================
// 建立一個簡單的網頁伺服器
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running and alive!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`喚醒用網頁伺服器已啟動於 port ${PORT}`);
});
// =========================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages, // 加入發送訊息的 intent
    ],
});

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

// 處理語音連線與斷線重連邏輯
function connectToChannel(channel) {
    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
    });

    // 捕捉連線錯誤 (例如 522 Timeout)，避免直接導致程式崩潰 (Exit status 1)
    connection.on('error', (error) => {
        console.error(`[語音連線發生錯誤] 頻道 ${channel.name}:`, error.message);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
        try {
            // 等待一下看是否能自動重連 (例如伺服器切換)
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch (error) {
            console.log(`[中斷連線] 嘗試重新連接 ${channel.name}...`);
            
            // 若為真正斷線，必須先銷毀原本的無效連線，否則無法重連！
            connection.destroy();
            
            const data = loadData();
            if (data[channel.guild.id] === channel.id) {
                // 如果真的斷開離開了，發送被強迫離開的提示訊息
                try {
                    await channel.send('⚠️ **機器人已被強迫離開頻道 (可能因 Discord 閒置或網路中斷)！** 正在嘗試自動重連...');
                } catch (e) {
                    console.error('無法發送離開訊息:', e);
                }
                
                // 延遲 2 秒後再次強制加入
                setTimeout(() => {
                    connectToChannel(channel);
                }, 2000);
            }
        }
    });

    // 播放無聲音訊，防止 Discord 因為閒置過久而自動踢除機器人
    const player = createAudioPlayer({
        behaviors: {
            noSubscriber: NoSubscriberBehavior.Play,
        },
    });
    
    // 建立無聲音訊資源並播放
    const playSilence = () => {
        const resource = createAudioResource(new Silence(), { inputType: StreamType.Opus });
        player.play(resource);
    };

    player.on('stateChange', (oldState, newState) => {
        // 當播放結束或變為 idle 時，自動重新播放無聲音訊
        if (newState.status === 'idle') {
            playSilence();
        }
    });

    player.on('error', error => {
        console.error('Audio player error:', error.message);
    });

    connection.subscribe(player);
    playSilence();

    return connection;
}

client.once(Events.ClientReady, async (c) => {
    console.log(`已成功登入為 ${c.user.tag}!`);
    console.log(`語音掛機機器人已啟動。`);

    // 設定機器人狀態與版本號
    const BOT_VERSION = '1.0';
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

    // 自動重連先前儲存的頻道
    const envChannelId = process.env.VOICE_CHANNEL_ID;
    
    if (envChannelId) {
        // 如果有在 Render 設定環境變數，絕對不會被刪除！
        try {
            const channel = await client.channels.fetch(envChannelId);
            if (channel && channel.isVoiceBased()) {
                connectToChannel(channel);
                console.log(`🔄 [環境變數重連] 已重新加入語音頻道：${channel.name}`);
            }
        } catch (err) {
            console.error(`無法透過環境變數加入頻道 (${envChannelId}):`, err);
        }
    } else {
        // 備用方案：讀取本地 data.json (但在 Render 會被刪除)
        const data = loadData();
        for (const guildId in data) {
            const channelId = data[guildId];
            try {
                const guild = await client.guilds.fetch(guildId);
                const channel = await guild.channels.fetch(channelId);
                if (channel) {
                    connectToChannel(channel);
                    console.log(`🔄 [本地紀錄重連] 已重新加入語音頻道：${channel.name}`);
                }
            } catch (err) {
                console.error(`自動加入頻道失敗 (${guildId}):`, err);
            }
        }
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

        connection.destroy();
        await interaction.reply('✅ 已退出語音頻道。');
    }
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
