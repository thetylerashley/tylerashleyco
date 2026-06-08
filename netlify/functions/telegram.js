// netlify/functions/telegram.js
//
// Telegram -> Hugo content pipeline for Cali's page.
// Handles three content types, each with its own write behavior:
//   feed:   20                          -> append { date, ml } to data/feedings.yaml
//   weight: 1010                        -> overwrite current_g in data/weight.yaml
//   update: Cali opened his eyes today  -> append { author, time, body } to data/updates.yaml
//
// Flow: message -> preview with inline Yes/No -> commit on Yes.
// Only whitelisted Telegram chat IDs can write. Each ID maps to an author name.

const TG_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Map Telegram numeric chat IDs -> author name used in updates.yaml.
// Find your IDs by messaging the bot once and reading the logged chat.id (see setup notes).
const AUTHORS = {
  [process.env.TYLER_CHAT_ID]: "tyler",
  [process.env.TORI_CHAT_ID]: "tori",
};

const GH = {
  owner: process.env.GITHUB_OWNER,
  repo: process.env.GITHUB_REPO,
  branch: process.env.GITHUB_BRANCH || "main",
  token: process.env.GITHUB_TOKEN,
};

// ---- date helper: returns M/DD in America/New_York, matching existing files ----
function today() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "2-digit",
  }).formatToParts(new Date());
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${m}/${d}`; // unpadded M/DD — used by updates.yaml
}

// feedings.yaml uses zero-padded MM/DD
function todayPadded() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${m}/${d}`;
}

// ---- parse an incoming message into a structured action ----
function parseMessage(text) {
  const trimmed = (text || "").trim();
  const idx = trimmed.indexOf(":");
  if (idx === -1) return null;

  const key = trimmed.slice(0, idx).trim().toLowerCase();
  const value = trimmed.slice(idx + 1).trim();
  if (!value) return null;

  if (key === "feed" || key === "feeding") {
    const ml = Number(value);
    if (!Number.isFinite(ml)) return { error: `"${value}" isn't a number.` };
    return { type: "feed", ml };
  }
  if (key === "weight") {
    const g = Number(value);
    if (!Number.isFinite(g)) return { error: `"${value}" isn't a number.` };
    return { type: "weight", grams: g };
  }
  if (key === "update" || key === "note") {
    return { type: "update", body: value };
  }
  return null;
}

// ---- human-readable preview shown before committing ----
function previewText(action, author) {
  const d = today();
  if (action.type === "feed") return `Feeding for ${d}: ${action.ml} ml`;
  if (action.type === "weight") return `Weight: ${action.grams} g (current_g)`;
  if (action.type === "update") return `Update (${author}, ${d}):\n${action.body}`;
}

// ---- escape a string for safe embedding in a double-quoted YAML scalar ----
function yamlString(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ---- apply an action to file content; returns { path, content, message } ----
function applyAction(action, author, files) {
  const d = today();

  if (action.type === "feed") {
    const path = "data/feedings.yaml";
    const line = `- { date: "${todayPadded()}", ml: ${action.ml} }`;
    const body = files[path].replace(/\s*$/, "") + `\n${line}\n`;
    return { path, content: body, message: `feeding ${d}: ${action.ml}ml` };
  }

  if (action.type === "weight") {
    const path = "data/weight.yaml";
    const body = files[path].replace(
      /^current_g:\s*.*$/m,
      `current_g: ${action.grams}`
    );
    return { path, content: body, message: `weight ${d}: ${action.grams}g` };
  }

  if (action.type === "update") {
    const path = "data/updates.yaml";
    const line = `- { author: ${author}, time: "${d}", body: "${yamlString(
      action.body
    )}" }`;
    const body = files[path].replace(/\s*$/, "") + `\n${line}\n`;
    return { path, content: body, message: `update ${d} by ${author}` };
  }
}

// ---- GitHub: read a file (returns { text, sha }) ----
async function ghGetFile(path) {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${path}?ref=${GH.branch}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GH.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cali-bot",
    },
  });
  if (!res.ok) throw new Error(`GitHub read ${path}: ${res.status}`);
  const json = await res.json();
  return {
    text: Buffer.from(json.content, "base64").toString("utf8"),
    sha: json.sha,
  };
}

// ---- GitHub: commit a file update ----
async function ghPutFile(path, content, sha, message) {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${path}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GH.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cali-bot",
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      sha,
      branch: GH.branch,
    }),
  });
  if (!res.ok) throw new Error(`GitHub write ${path}: ${res.status}`);
  return res.json();
}

// ---- Telegram helpers ----
async function tgSend(chatId, text, replyMarkup) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    }),
  });
}

async function tgAnswerCallback(callbackId, text) {
  await fetch(`${TG_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
}

// Encode the pending action into the callback button data (Telegram limit: 64 bytes).
// For long updates we store the body separately and reference by a short token instead.
function confirmKeyboard(token) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Yes, save", callback_data: `ok:${token}` },
        { text: "✖ Cancel", callback_data: `no:${token}` },
      ],
    ],
  };
}

// Lightweight pending store. Netlify Functions are stateless across invocations,
// so we encode the whole action into the message itself: the preview text the bot
// sent IS the source of truth, and we re-parse it on confirm. See setup notes for
// the durable-store upgrade (Netlify Blobs) if you want it.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "ok" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 200, body: "ok" };
  }

  // ---- Case 1: a button was pressed (confirmation) ----
  if (body.callback_query) {
    const cq = body.callback_query;
    const chatId = String(cq.message.chat.id);
    const author = AUTHORS[chatId];
    if (!author) {
      await tgAnswerCallback(cq.id, "Not authorized.");
      return { statusCode: 200, body: "ok" };
    }

    const [verb] = cq.data.split(":");
    if (verb === "no") {
      await tgAnswerCallback(cq.id, "Cancelled.");
      await tgSend(chatId, "Cancelled — nothing was saved.");
      return { statusCode: 200, body: "ok" };
    }

    // Re-derive the action from the original message text the user sent,
    // which Telegram includes as the replied-to message.
    const originalText = cq.message.reply_to_message
      ? cq.message.reply_to_message.text
      : null;
    const action = originalText ? parseMessage(originalText) : null;

    if (!action || action.error) {
      await tgAnswerCallback(cq.id, "Couldn't re-read that. Send it again.");
      return { statusCode: 200, body: "ok" };
    }

    try {
      // Read the one file this action touches, apply, commit.
      const pathFor = {
        feed: "data/feedings.yaml",
        weight: "data/weight.yaml",
        update: "data/updates.yaml",
      }[action.type];

      const { text, sha } = await ghGetFile(pathFor);
      const files = { [pathFor]: text };
      const { path, content, message } = applyAction(action, author, files);
      await ghPutFile(path, content, sha, message);

      await tgAnswerCallback(cq.id, "Saved!");
      await tgSend(chatId, `✅ Committed: ${message}\nSite will rebuild shortly.`);
    } catch (err) {
      await tgAnswerCallback(cq.id, "Error saving.");
      await tgSend(chatId, `⚠️ Something went wrong: ${err.message}`);
    }
    return { statusCode: 200, body: "ok" };
  }

  // ---- Case 2: a normal message ----
  const msg = body.message;
  if (!msg || !msg.text) return { statusCode: 200, body: "ok" };

  const chatId = String(msg.chat.id);
  const author = AUTHORS[chatId];

  // Log unknown IDs so you can read them during setup, then reject.
  if (!author) {
    console.log("Message from unauthorized chat id:", chatId, msg.text);
    return { statusCode: 200, body: "ok" };
  }

  const action = parseMessage(msg.text);

  if (!action) {
    await tgSend(
      chatId,
      "Send one of:\n• feed: 20\n• weight: 1010\n• update: your text here"
    );
    return { statusCode: 200, body: "ok" };
  }
  if (action.error) {
    await tgSend(chatId, `⚠️ ${action.error}`);
    return { statusCode: 200, body: "ok" };
  }

  // Send the preview as a REPLY to the user's message, so the confirm handler
  // can read the original text back off reply_to_message. force_reply links them.
  const preview = previewText(action, author);
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `${preview}\n\nSave this?`,
      reply_to_message_id: msg.message_id,
      reply_markup: confirmKeyboard(msg.message_id),
    }),
  });

  return { statusCode: 200, body: "ok" };
};