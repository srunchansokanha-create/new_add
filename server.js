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

    // ✅ ONLY USERS WITH USERNAME
    const usernames = members
      .filter(m => m.username && m.username.trim() !== "")
      .map(m => "@" + m.username); // optional @ prefix

    res.json({
      success: true,
      ids: usernames
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
      const user = usernames[u];

      try {
        await connect(client);

        const entity = await client.getEntity(user);

        await client.invoke(new Api.channels.InviteToChannel({
          channel: group,
          users: [entity]
        }));

        // ✅ SUCCESS → SHOW DELAY ONLY HERE
        await sleep(2000);

        stats.success++;
        logs.push({
          username: user,
          account: accName,
          status: "success"
        });

        await sleep(DELAY);

      } catch (err) {

        stats.fail++;
        logs.push({
          username: user,
          account: accName,
          status: "fail"
        });

        // ❌ FAIL = NO DELAY (IMPORTANT FIX)
        if (err.message?.includes("FLOOD_WAIT")) {
          a = (a + 1) % active.length;
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
