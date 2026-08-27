const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

// Add imports
code = code.replace(
    /const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState } = require\('@discordjs\/voice'\);/,
    "const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState, createAudioPlayer, createAudioResource, StreamType } = require('@discordjs/voice');\nconst { Readable } = require('stream');\n\nclass Silence extends Readable {\n    _read() {\n        this.push(Buffer.from([0xf8, 0xff, 0xfe]));\n    }\n}"
);

// Add silence playing
code = code.replace(
    /return connection;\n}/,
        const player = createAudioPlayer();\n    connection.subscribe(player);\n    player.play(createAudioResource(new Silence(), { inputType: StreamType.Opus }));\n    return connection;\n}
);

fs.writeFileSync('index.js', code);
console.log('Patched');
