# Voice AFK Bot

這是一個使用 `discord.js` v14 與 `@discordjs/voice` 製作的語音頻道掛機機器人。
它可以加入語音頻道，並一直待在裡面，就算頻道空無一人也不會自動離開，直到你下指令叫它離開。

## 功能指令

*   `!join`: 讓機器人加入你目前所在的語音頻道並開始掛機。
*   `!leave`: 讓機器人離開目前的語音頻道。

## 安裝與執行

1. 確保你已經安裝了 [Node.js](https://nodejs.org/)。
2. 複製 `.env.example` 檔案並重新命名為 `.env`。
3. 在 Discord Developer Portal 取得你的 Bot Token，並將其填入 `.env` 檔案中的 `TOKEN` 欄位。
4. 在終端機 (Terminal) 中，進入 `AFKBot` 資料夾。
5. 執行 `npm install` 來安裝必要的套件 (包含語音連線所需的套件)。
6. 執行 `node index.js` 來啟動機器人。

## 權限設定 (Intents)

在 Discord Developer Portal 中，你需要確保機器人開啟了以下權限：
*   **Message Content Intent**: 讀取文字指令 (`!join`, `!leave`)。

此外，在把機器人邀請進伺服器時，請確保給予他**加入語音頻道 (Connect)** 的權限。
