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

/* ========================
   RENDER PORT FIX
======================== */
const PORT = process.env.PORT || 10000;
const DELAY = parseInt(process.env.DELAY_MS) || 30000;

/* ========================
   SERVE INDEX.HTML
======================== */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ========================
   STATE
======================== */
let clients = {};
let stats = { success: 0, fail: 0 };
let logs = [];
let isRunning = false;
let accountStatus = {};

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
    if (!client.connected) await client.connect();
  } catch {}
}

async function resolveEntity(client, input) {
  try {
    return await client.getEntity(input);
  } catch {
    return null;
  }
}

/* ========================
   ACCOUNT CHECK
======================== */
async function refreshAccountStatus() {
  for (const name of Object.keys(clients)) {
    try {
      await safeConnect(clients[name]);
      await clients[name].getMe();
      accountStatus[name] = "ACTIVE";
    } catch (err) {
      accountStatus[name] = err.message?.includes("FLOOD_WAIT")
        ? "FLOOD"
        : "ERROR";
    }
  }
}

/* ========================
   API
======================== */

app.get("/accounts", (req, res) => {
  res.json(Object.keys(clients));
});

app.get("/account-status", (req, res) => {
  res.json(
    Object.keys(clients).map(name => ({
      account: name,
      status: accountStatus[name] || "UNKNOWN"
    }))
  );
});

app.post("/check-accounts", async (req, res) => {
  await refreshAccountStatus();
  res.json({ message: "checked" });
});

/* ========================
   EXPORT MEMBERS
======================== */
app.post("/export-members", async (req, res) => {
  const { account, group } = req.body;

  const client = clients[account];
  if (!client) return res.json({ success: false });

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
   START PROCESS
======================== */
app.post("/start", async (req, res) => {
  const { group, usernames, accounts } = req.body;

  if (isRunning)
    return res.json({ message: "Already running" });

  await refreshAccountStatus();

  const activeAccounts = accounts.filter(
    a => accountStatus[a] === "ACTIVE"
  );

  if (!activeAccounts.length)
    return res.json({ message: "No ACTIVE accounts" });

  isRunning = true;
  stats = { success: 0, fail: 0 };
  logs = [];

  let userIndex = 0;
  let accIndex = 0;

  while (isRunning && userIndex < usernames.length) {

    const accountName = activeAccounts[accIndex];
    const client = clients[accountName];
    const username = usernames[userIndex];

    try {

      await safeConnect(client);

      const user = await resolveEntity(client, username);
      const groupEntity = await resolveEntity(client, group);

      if (!user || !groupEntity) {
        stats.fail++;
        logs.push({ username, status: "fail" });
        userIndex++;
        continue;
      }

      await client.invoke(
        new Api.channels.InviteToChannel({
          channel: groupEntity,
          users: [user]
        })
      );

      await sleep(2000);

      let ok = false;

      try {
        await client.invoke(
          new Api.channels.GetParticipant({
            channel: groupEntity,
            participant: user
          })
        );
        ok = true;
      } catch {
        ok = false;
      }

      if (ok) {
        stats.success++;
        logs.push({ username, status: "success" });
      } else {
        stats.fail++;
        logs.push({ username, status: "fail" });
      }

      userIndex++;

    } catch (err) {

      if (err.message?.includes("FLOOD_WAIT")) {
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

  res.json({
    message: "Finished"
  });
});

/* ========================
   STOP / RESTART
======================== */
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

/* ========================
   STATS
======================== */
app.get("/stats", (req, res) => {
  res.json(stats);
});

/* ========================
   LOGS
======================== */
app.get("/member-logs", (req, res) => {
  res.json(logs.slice(-500));
});

/* ========================
   START SERVER
======================== */
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
