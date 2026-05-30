require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const DELAY = parseInt(process.env.DELAY_MS) || 30000;

/* ========================
   STATE
======================== */

let clients = {};
let stats = { success: 0, fail: 0 };
let logs = [];

let isRunning = false;

let accountStatus = {}; // 👈 ACTIVE / ERROR / FLOOD

/* ========================
   LOAD ACCOUNTS
======================== */

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

/* ========================
   HELPERS
======================== */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeConnect(client) {
  try {
    await client.connect();
  } catch {}
}

/* ========================
   ACCOUNT HEALTH CHECK
======================== */

async function checkAccount(name, client) {
  try {
    await safeConnect(client);

    const me = await client.getMe();

    if (!me) {
      accountStatus[name] = "ERROR";
      return;
    }

    accountStatus[name] = "ACTIVE";
    console.log(`✅ ${name} ACTIVE`);

  } catch (err) {
    const msg = err.message || "";

    if (msg.includes("FLOOD_WAIT")) {
      accountStatus[name] = "FLOOD";
    } else {
      accountStatus[name] = "ERROR";
    }

    console.log(`❌ ${name} = ${accountStatus[name]}`);
  }
}

/* ========================
   INIT CHECK ON START
======================== */

(async () => {
  for (const name of Object.keys(clients)) {
    await checkAccount(name, clients[name]);
  }
})();

/* ========================
   API: ACCOUNTS
======================== */

app.get("/accounts", (req, res) => {
  res.json(Object.keys(clients));
});

/* ========================
   API: ACCOUNT STATUS
======================== */

app.get("/account-status", (req, res) => {
  const result = Object.keys(clients).map(name => ({
    account: name,
    status: accountStatus[name] || "UNKNOWN"
  }));

  res.json(result);
});

/* ========================
   RECHECK ACCOUNTS
======================== */

app.post("/check-accounts", async (req, res) => {
  for (const name of Object.keys(clients)) {
    await checkAccount(name, clients[name]);
  }

  res.json({ message: "Rechecked accounts" });
});

/* ========================
   EXPORT MEMBERS
======================== */

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

/* ========================
   START PROCESS (FULL FIX)
======================== */

app.post("/start", async (req, res) => {
  const { group, usernames, accounts } = req.body;

  if (isRunning) {
    return res.json({ message: "Already running" });
  }

  // 🔥 only ACTIVE accounts
  const activeAccounts = accounts.filter(acc => accountStatus[acc] === "ACTIVE");

  if (!activeAccounts.length) {
    return res.json({ message: "No ACTIVE accounts available" });
  }

  isRunning = true;
  stats = { success: 0, fail: 0 };
  logs = [];

  let userIndex = 0;
  let accIndex = 0;

  async function isMember(client, group, user) {
    try {
      await client.invoke(
        new Api.channels.GetParticipant({
          channel: group,
          participant: user
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  (async () => {
    while (isRunning && userIndex < usernames.length) {

      const accountName = activeAccounts[accIndex];
      const client = clients[accountName];
      const username = usernames[userIndex];

      try {
        await safeConnect(client);

        const user = await client.getEntity(username);

        await client.invoke(
          new Api.channels.InviteToChannel({
            channel: group,
            users: [user]
          })
        );

        await sleep(2500);

        // 🔥 REAL VERIFY (NO FAKE SUCCESS)
        const ok = await isMember(client, group, user);

        if (ok) {
          stats.success++;
          logs.push({ username, status: "success" });
          console.log(`✅ REAL SUCCESS: ${username}`);
        } else {
          stats.fail++;
          logs.push({ username, status: "fail" });
          console.log(`❌ NOT JOINED: ${username}`);
        }

        userIndex++;

      } catch (err) {
        const msg = err.message || "";

        if (msg.includes("FLOOD_WAIT")) {
          console.log(`⚠ FLOOD → switching account`);
          accIndex = (accIndex + 1) % activeAccounts.length;
        } else {
          stats.fail++;
          logs.push({ username, status: "fail" });
          userIndex++;
        }
      }

      await sleep(DELAY);
    }

    isRunning = false;
    console.log("🛑 FINISHED");
  })();

  res.json({
    message: `Started with ${activeAccounts.length} ACTIVE accounts`
  });
});

/* ========================
   STOP
======================== */

app.post("/stop", (req, res) => {
  isRunning = false;
  res.json({ message: "Stopped" });
});

/* ========================
   RESTART
======================== */

app.post("/restart", (req, res) => {
  isRunning = false;
  stats = { success: 0, fail: 0 };
  logs = [];
  res.json({ message: "Restarted" });
});

/* ========================
   STATS
======================== */

app.get("/stats", (req, res) => {
  res.json(stats);
});

/* ========================
   LOGS (SAFE LIMIT)
======================== */

app.get("/member-logs", (req, res) => {
  res.json(logs.slice(-500));
});

/* ========================
   START SERVER
======================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});