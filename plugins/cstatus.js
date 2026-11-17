cmd({
    pattern: "cstatus",
    alias: ["channelstatus"],
    desc: "Publish channel status",
    category: "channel",
    react: "📢",
    filename: __filename
}, async (conn, mek, m, { q, reply, isOwner, quoted }) => {
    try {
        if (!isOwner) {
            return reply("🚫 Owner only command.");
        }

        if (!q) {
            return reply(
                `❎ Usage:\n\n` +
                `.cstatus <CHANNEL_JID> <Status text>\n\n` +
                `Reply to an image, video or voice note:\n` +
                `.cstatus <CHANNEL_JID> [Caption]\n\n` +
                `${config.BOT_FOOTER}`
            );
        }

        const args = q.trim().split(/\s+/);
        const jid = args.shift();
        const caption = args.join(" ").trim();

        if (!jid || !jid.endsWith("@newsletter")) {
            return reply("⚠️ Invalid Channel JID.");
        }

        if (typeof conn.sendNewsletterStatus !== "function") {
            return reply("❌ sendNewsletterStatus() is unavailable in your Baileys version.");
        }

        const permission = await conn.newsletterCanPostStatus(jid);

        if (!permission?.canPost) {
            return reply("🚫 This channel cannot publish statuses.");
        }

        let payload;
        let statusType = "Text";

        const quotedMsg = quoted || m.quoted;

        if (!quotedMsg) {
            if (!caption) {
                return reply("⚠️ Please enter status text.");
            }

            payload = {
                text: caption
            };

        } else {
            const candidates = [
                quotedMsg.msg,
                quotedMsg.message,
                quotedMsg.msg?.message,
                quotedMsg.message?.message,
                quotedMsg
            ].filter(Boolean);

            let mediaMessage = null;
            let mediaType = null;

            for (const msg of candidates) {
                if (msg.imageMessage) {
                    mediaMessage = msg.imageMessage;
                    mediaType = "image";
                    break;
                }

                if (msg.videoMessage) {
                    mediaMessage = msg.videoMessage;
                    mediaType = "video";
                    break;
                }

                if (msg.audioMessage?.ptt === true) {
                    mediaMessage = msg.audioMessage;
                    mediaType = "audio";
                    break;
                }
            }

            if (!mediaMessage) {
                const mtype = quotedMsg.mtype || quotedMsg.type;

                if (mtype === "imageMessage" && quotedMsg.msg) {
                    mediaMessage = quotedMsg.msg;
                    mediaType = "image";
                } else if (mtype === "videoMessage" && quotedMsg.msg) {
                    mediaMessage = quotedMsg.msg;
                    mediaType = "video";
                } else if (mtype === "audioMessage" && quotedMsg.msg?.ptt === true) {
                    mediaMessage = quotedMsg.msg;
                    mediaType = "audio";
                }
            }

            if (!mediaMessage || !mediaType) {
                return reply(
                    `❌ Please reply to a valid image, video, or voice note.\n\n${config.BOT_FOOTER}`
                );
            }

            const stream = await downloadContentFromMessage(
                mediaMessage,
                mediaType
            );

            const chunks = [];

            for await (const chunk of stream) {
                chunks.push(chunk);
            }

            const buffer = Buffer.concat(chunks);

            if (!buffer.length) {
                return reply("❌ Failed to download media.");
            }

            if (mediaType === "image") {
                payload = {
                    image: buffer,
                    caption
                };
                statusType = "Image";

            } else if (mediaType === "video") {
                payload = {
                    video: buffer,
                    caption
                };
                statusType = "Video";

            } else if (mediaType === "audio") {
                payload = {
                    audio: buffer,
                    mimetype: mediaMessage.mimetype || "audio/ogg",
                    ptt: true
                };
                statusType = "Voice Note";
            }
        }

        await reply("⏳ Publishing channel status...");

        const result = await conn.sendNewsletterStatus(jid, payload);

        console.log("CSTATUS RESULT:", result);

        return reply(
            `✅ CHANNEL STATUS PUBLISHED!\n\n` +
            `📢 Channel: ${jid}\n` +
            `📌 Type: ${statusType}\n` +
            `📝 Caption: ${caption || "None"}\n\n` +
            `${config.BOT_FOOTER}`
        );

    } catch (e) {
        console.error("CSTATUS ERROR:", e);

        return reply(
            `❌ Failed to publish channel status!\n\n` +
            `Error: ${e.message}\n\n` +
            `${config.BOT_FOOTER}`
        );
    }
});

