const { cmd } = require('../command');
const axios = require('axios');

cmd({
    pattern: "fetch",
    desc: "Fetch a file from a URL.",
    category: "download",
    react: "📥",
    filename: __filename
},
async (conn, mek, m, {
    from,
    q,
    sender,
    reply,
    isOwner
}) => {
    try {
        if (!q) {
            return await reply(
                "📥 Please provide the URL of the file you want to fetch.\n\nExample:\n*fetch https://example.com/file.zip*"
            );
        }

        const url = String(q).trim();

        if (!/^https?:\/\//i.test(url)) {
            return await reply("❌ Please provide a valid HTTP/HTTPS URL.");
        }

        const response = await axios({
            method: "GET",
            url: url,
            responseType: "stream",
            timeout: 180000,
            maxRedirects: 10,
            headers: {
                "User-Agent": "Mozilla/5.0"
            }
        });

        const mime =
            response.headers["content-type"] ||
            "application/octet-stream";

        let name = decodeURIComponent(
            url.split("/").pop()?.split("?")[0] || "file"
        );

        if (!name.includes(".")) {
            const ext =
                mime.split("/")[1]?.split(";")[0] || "bin";

            name += `.${ext}`;
        }

        const fileName = `🅢🅗🅘🅡🅞-🅜🅓.${name}`;

        await conn.sendMessage(
            from,
            {
                document: {
                    stream: response.data
                },
                mimetype: mime,
                fileName: fileName
            },
            {
                quoted: mek
            }
        );

    } catch (err) {
        console.log("FETCH ERROR:", {
            message: err.message,
            code: err.code,
            status: err.response?.status
        });

        await reply(
            `❌ Failed to fetch the file.\n\nError: ${err.message}`
        );
    }
});
