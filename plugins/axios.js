const { cmd } = require('../command');
const config = require('../config');
const axios = require('axios');

cmd({
    pattern: "axios",
    desc: "Fetch data from an API URL.",
    category: "other",
    react: "🌐",
    filename: __filename
},
async (conn, mek, m, {
    from,
    args,
    reply,
    sender,
    isOwner
}) => {
    try {
        const url = args[0];

        if (!url) {
            return await reply(
                "🌐 Please provide an API URL.\n\n" +
                "Example:\n" +
                "*axios https://example.com/api*"
            );
        }

        if (!/^https?:\/\//i.test(url)) {
            return await reply(
                "❌ Please provide a valid HTTP/HTTPS URL."
            );
        }

        const res = await axios.get(url, {
            timeout: 30000
        });

        let output;

        if (typeof res.data === "object") {
            output = JSON.stringify(
                res.data,
                null,
                2
            );
        } else {
            output = String(res.data);
        }

        await conn.sendMessage(from, {
            text:
                `💫 *API Response*\n\n` +
                `${output}\n\n` +
                `${config.BOT_FOOTER}`
        }, {
            quoted: mek
        });

    } catch (err) {
        await reply(
            `❌ API request failed.\n\nError: ${err.message}`
        );
    }
});
