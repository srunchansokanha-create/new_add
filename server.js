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

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 3000;
const DELAY = parseInt(process.env.DELAY_MS) || 30000;

/* =========================
   SERVE INDEX
========================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* =========================
   STATE
========================= */
let clients = {};
let stats = { success: 0, fail: 0 };
let logs = [];
let accountStatus = {};
let isRunning = false;

/* =========================
   LOAD ACCOUNTS
========================= */
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

/* =========================
   HELPERS
========================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeConnect(client) {
  try {
    await client.connect();
  } catch {}
}

/* =========================
   ACCOUNT CHECK (FIXED)
========================= */
async function checkAccount(name, client) {
  try {
    await safeConnect(client);

    const me = await client.getMe();

    if (me && me.id) {
      accountStatus[name] = "ACTIVE";
    } else {
      accountStatus[name] = "ERROR";
    }

  } catch (err) {
    if (err.message?.includes("FLOOD_WAIT")) {
      accountStatus[name] = "FLOOD";
    } else {
      accountStatus[name] = "ERROR";
    }
  }
}

/* AUTO CHECK ON START */
async function refreshAccountStatus() {
  for (const name of Object.keys(clients)) {
    await checkAccount(name, clients[name]);
  }
}

refreshAccountStatus();

/* =========================
   ROUTES
========================= */
app.get("/accounts", (req, res) => {
  res.json(Object.keys(clients));
});

/* LIVE STATUS FIX */
app.get("/account-status", async (req, res) => {
  await refreshAccountStatus();

  res.json(
    Object.keys(clients).map(name => ({
      account: name,
      status: accountStatus[name] || "ERROR"
    }))
  );
});

/* MANUAL CHECK */
app.post("/check-accounts", async (req, res) => {
  await refreshAccountStatus();
  res.json({ message: "Account status updated" });
});

/* EXPORT MEMBERS */
app.post("/export-members", async (req, res) => {
  const { account, group } = req.body;

  const client = clients[account];
  if (!client) return res.json({ success: false, error: "Account not found" });

  try {
    await safeConnect(client);

    const participants = await client.getParticipants(group);
    const ids = participants.map(p => p.username || p.id).filter(Boolean);

    res.json({ success: true, ids });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* =========================
   START (REAL CHECK FIX)
========================= */
app.post("/start", async (req, res) => {
  const { group, usernames, accounts } = req.body;

  if (isRunning) return res.json({ message: "Already running" });

  const active = accounts.filter(a => accountStatus[a] === "ACTIVE");
  if (!active.length) return res.json({ message: "No ACTIVE accounts" });

  isRunning = true;
  stats = { success: 0, fail: 0 };
  logs = [];
  accountLive = {};

  let i = 0;
  let acc = 0;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  (async () => {
    while (isRunning && i < usernames.length) {

      const accountName = active[acc];
      const client = clients[accountName];
      const user = usernames[i];

      try {
        await connect(client);

        accountLive[accountName] = `adding ${user}`;

        const entity = await client.getEntity(user);

        await client.invoke(new Api.channels.InviteToChannel({
          channel: group,
          users: [entity]
        }));

        // ✅ SUCCESS → show + DELAY
        stats.success++;
        logs.push({
          username: user,
          status: "success",
          account: accountName
        });

        accountLive[accountName] = `SUCCESS ${user} ⏳ waiting...`;

        await sleep(DELAY);

        i++;

      } catch (err) {

        const msg = err.message || "";

        // ⚠ FLOOD WAIT → skip account immediately
        if (msg.includes("FLOOD_WAIT")) {

          accountLive[accountName] = "⚠ FLOOD SKIP ACCOUNT";

          acc = (acc + 1) % active.length;

          await sleep(1000); // small switch delay only

          continue;
        }

        // ❌ FAIL → NO DELAY, skip instantly
        stats.fail++;

        logs.push({
          username: user,
          status: "fail",
          account: accountName
        });

        accountLive[accountName] = `❌ FAIL ${user}`;

        i++; // move next user immediately
      }
    }

    isRunning = false;
    accountLive = {};
  })();

  res.json({ message: "Smart Add Started (No Fail Delay + Auto Flood Skip)" });
});

/* =========================
   STOP / RESTART
========================= */
app.post("/stop", (req, res) => {
  isRunning = false;
  res.json({ message: "Stopped" });
});

app.post("/restart", (req, res) => {
  isRunning = false;
  stats = { success: 0, fail: 0 };
  logs = [];
  res.json({ message: "Restarted" });
});

/* =========================
   STATS
========================= */
app.get("/stats", (req, res) => {
  res.json(stats);
});

/* =========================
   LOGS
========================= */
app.get("/member-logs", (req, res) => {
  res.json(logs.slice(-500));
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
