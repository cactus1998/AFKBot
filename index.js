require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, ChannelType, Events } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const http = require('http'); // 引入 http 模組來建立簡易網頁

// =========================================================
// 建立一個簡單的網頁伺服器，這是為了給 Render 還有 UptimeRobot 讀取的
// 讓機器人以為這是一個「網站」，它才不會睡著。
// =========================================================
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running and alive!');
});
// Render 會自動分配一個 PORT (通訊埠)，如果沒有的話就用 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`喚醒用網頁伺服器已啟動於 port ${PORT}`);
});
// =========================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates, // 語音狀態必備
    ],
});

// 1. 定義斜線指令 (Slash Commands)
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

// 2. 機器人啟動時的設定
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
});

// 當機器人被加進新的伺服器時，自動註冊指令
client.on(Events.GuildCreate, async (guild) => {
    try {
        await guild.commands.set(commands);
        console.log(`已自動在伺服器 ${guild.name} 註冊指令。`);
    } catch (error) {
        console.error(`在伺服器 ${guild.name} 註冊指令失敗:`, error);
    }
});

// 3. 處理使用者輸入的斜線指令
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'join') {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ 只有管理員可以使用這個指令！', ephemeral: true });
        }

        const voiceChannel = interaction.options.getChannel('channel');

        try {
            joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });
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
        
        if (!connection) {
            return interaction.reply({ content: '我目前不在任何語音頻道中！', ephemeral: true });
        }

        connection.destroy();
        await interaction.reply('✅ 已退出語音頻道。');
    }
});

client.login(process.env.TOKEN);
