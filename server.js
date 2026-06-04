require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const DELAY = parseInt(process.env.DELAY_MS) || 30000;

/* ================= STATE ================= */
let clients = {};
let stats = { success: 0, fail: 0 };
let logs = [];
let accountStatus = {};
let isRunning = false;

/* ================= LOAD ACCOUNTS ================= */
for (let i = 1; i <= 10; i++) {
  const apiId = process.env[`API_ID_${i}`];
  const apiHash = process.env[`API_HASH_${i}`];
  const session = process.env[`SESSION_${i}`];

  if (apiId && apiHash && session) {
    clients[`account${i}`] = new TelegramClient(
      new StringSession(session),
      parseInt(apiId),
      apiHash,
      { connectionRetries: 5 }
    );
  }
}

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function connect(client) {
  try { await client.connect(); } catch {}
}

/* ================= FAST ACCOUNT CHECK (CACHE) ================= */
async function refreshAccountStatus() {
  for (const name of Object.keys(clients)) {
    try {
      const client = clients[name];
      await connect(client);

      const me = await client.getMe();
      accountStatus[name] = me ? "ACTIVE" : "ERROR";

    } catch (err) {
      accountStatus[name] =
        err.message?.includes("FLOOD_WAIT") ? "FLOOD" : "ERROR";
    }
  }
}

/* run once every 15 sec (IMPORTANT FIX) */
setInterval(refreshAccountStatus, 15000);
refreshAccountStatus();

/* ================= ROUTES ================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/accounts", (req, res) => {
  res.json(Object.keys(clients));
});

/* ⚡ FAST RESPONSE (NO await inside route) */
app.get("/account-status", (req, res) => {
  res.json(
    Object.keys(clients).map(name => ({
      account: name,
      status: accountStatus[name] || "UNKNOWN"
    }))
  );
});

/* ================= EXPORT ================= */
app.post("/export-members", async (req, res) => {
  const { account, group } = req.body;

  const client = clients[account];
  if (!client) return res.json({ success: false, error: "Invalid account" });

  try {
    await connect(client);

    const members = await client.getParticipants(group);

    const data = members
      .filter(m => m.id && m.accessHash) // important
      .map(m => ({
        id: m.id,
        access_hash: m.accessHash,
        username: m.username ? "@" + m.username : null
      }));

    res.json({
      success: true,
      users: data
    });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* ================= START ENGINE ================= */
app.post("/start", async (req, res) => {
  const { group, usernames, accounts } = req.body;

  if (isRunning) return res.json({ message: "Already running" });

  await refreshAccountStatus();

  const active = accounts.filter(a => accountStatus[a] === "ACTIVE");
  if (!active.length) return res.json({ message: "No ACTIVE accounts" });

  isRunning = true;
  stats = { success: 0, fail: 0 };
  logs = [];

  let u = 0;
  let a = 0;

(async () => {
  while (isRunning && u < usernames.length) {

    const accName = active[a];
    const client = clients[accName];

    // format: id|access_hash|username
    const [id, accessHash, username] = usernames[u].split("|");

    try {
      await connect(client);

      const entity = {
        className: "InputUser",
        userId: BigInt(id),
        accessHash: BigInt(accessHash)
      };

      // 1️⃣ ADD MEMBER
      await client.invoke(new Api.channels.InviteToChannel({
        channel: group,
        users: [entity]
      }));

      await sleep(3000);

      // 2️⃣ VERIFY MEMBER JOINED
      let isJoined = false;

      try {
        await client.invoke(new Api.channels.GetParticipant({
          channel: group,
          participant: entity
        }));

        isJoined = true;
      } catch (e) {
        isJoined = false;
      }

      // 3️⃣ ONLY THEN SUCCESS
      if (isJoined) {
        stats.success++;
        logs.push({
          username: username || id,
          account: accName,
          status: "success"
        });
      } else {
        stats.fail++;
        logs.push({
          username: username || id,
          account: accName,
          status: "fail (not joined)"
        });
      }

      await sleep(DELAY);

    } catch (err) {

      stats.fail++;
      logs.push({
        username: username || id,
        account: accName,
        status: "fail"
      });

      if (err.message?.includes("FLOOD_WAIT")) {
        const wait = err.seconds || 5;
        await sleep(wait * 1000);
      }
    }

    u++;
  }

  isRunning = false;
})();

  res.json({ message: "Started" });
});

/* ================= STOP ================= */
app.post("/stop", (req, res) => {
  isRunning = false;
  res.json({ message: "Stopped" });
});

/* ================= STATS ================= */
app.get("/stats", (req, res) => {
  res.json(stats);
});

/* ================= LOGS ================= */
app.get("/member-logs", (req, res) => {
  res.json(logs.slice(-500));
});

/* ================= SERVER ================= */
app.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
});
