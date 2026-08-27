require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, ChannelType, Events } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState, createAudioPlayer, createAudioResource, StreamType } = require('@discordjs/voice');
const { Readable } = require('stream');
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

// 產生無限的靜音 (Opus frame)
class Silence extends Readable {
    _read() {
        this.push(Buffer.from([0xf8, 0xff, 0xfe]));
    }
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

    // 持續播放無聲的音訊，防止被 Discord 因為閒置而踢出
    const player = createAudioPlayer();
    connection.subscribe(player);
    player.play(createAudioResource(new Silence(), { inputType: StreamType.Opus }));

    connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
        try {
            // 等待一下看是否能自動重連 (例如伺服器切換)
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch (error) {
            console.log(`[中斷連線] 嘗試重新連接 ${channel.name}...`);
            // 若為真正斷線，手動重連
            const data = loadData();
            if (data[channel.guild.id] === channel.id) {
                connectToChannel(channel);
            } else {
                connection.destroy();
            }
        }
    });

    return connection;
}

client.once(Events.ClientReady, async (c) => {
    console.log(`已成功登入為 ${c.user.tag}!`);
    console.log(`語音掛機機器人已啟動。`);

    try {
        console.log('正在為伺服器註冊斜線指令 (/) ...');
        for (const guild of client.guilds.cache.values()) {
            await guild.commands.set(commands);
        }
        console.log('✅ 斜線指令註冊完成！');
    } catch (error) {
        console.error('註冊斜線指令時發生錯誤:', error);
    }

    // 自動重連先前儲存的頻道 (解決重啟後離開頻道的問題)
    const data = loadData();
    for (const guildId in data) {
        const channelId = data[guildId];
        try {
            const guild = await client.guilds.fetch(guildId);
            const channel = await guild.channels.fetch(channelId);
            if (channel) {
                connectToChannel(channel);
                console.log(`🔄 [自動重連] 已重新加入語音頻道：${channel.name}`);
            }
        } catch (err) {
            console.error(`自動加入頻道失敗 (${guildId}):`, err);
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

client.login(process.env.TOKEN);
