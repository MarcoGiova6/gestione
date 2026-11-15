// Notifiche per Gestione: ogni 5 minuti (GitHub Actions) spedisce le notifiche in coda
// e i promemoria giornalieri.
const admin = require("firebase-admin");

const FS = admin.firestore.FieldValue;
let db;
let nowFn = () => new Date();

const short = (t, n = 140) => {
  t = String(t || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function romeNow() {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(nowFn());
  const g = (t) => f.find((p) => p.type === t).value;
  return {date: `${g("year")}-${g("month")}-${g("day")}`, min: (+g("hour") % 24) * 60 + +g("minute")};
}

function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function mondayOf(date) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return addDays(date, -((dt.getUTCDay() + 6) % 7));
}

async function tokenItems(uids) {
  const items = [];
  const add = (uid, data) => {
    Object.entries((data && data.tokens) || {}).forEach(([key, v]) => {
      if (v && v.t) items.push({uid, key, t: v.t});
    });
  };
  if (!uids) {
    const q = await db.collection("push").get();
    q.forEach((d) => add(d.id, d.data()));
  } else {
    await Promise.all([...new Set(uids)].map(async (u) => {
      const d = await db.doc("push/" + u).get();
      if (d.exists) add(u, d.data());
    }));
  }
  return items;
}

async function send(uids, title, body, url) {
  const items = await tokenItems(uids);
  if (!items.length) return 0;
  const res = await admin.messaging().sendEachForMulticast({
    tokens: items.map((i) => i.t),
    data: {title: String(title), body: String(body || ""), url: String(url || "?tab=oggi")},
    webpush: {headers: {Urgency: "high", TTL: "86400"}},
    android: {priority: "high"},
  });
  await Promise.all(res.responses.map((r, i) => {
    const code = (r.error && r.error.code) || "";
    if (!r.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) {
      return db.doc("push/" + items[i].uid)
          .update(new admin.firestore.FieldPath("tokens", items[i].key), FS.delete()).catch(() => {});
    }
    return null;
  }));
  return res.successCount;
}

async function adminUid() {
  const d = await db.doc("meta/admin").get();
  return (d.exists && d.data().uid) || null;
}

async function resolveTo(n) {
  if (Array.isArray(n.to)) return n.to; // persone indicate: sempre
  if (n.to === "admin") {
    const a = await adminUid();
    return a && a !== n.by ? [a] : [];
  }
  if (n.to === "all") {
    const q = await db.collection("push").get();
    return q.docs.map((d) => d.id).filter((u) => u !== n.by);
  }
  return [];
}

// Persone in turno oggi ("Lavoro" nel Planner) con account collegato. Nessuno in turno = nessuno.
async function onShift(date) {
  const cfg = (await db.doc("config/main").get()).data() || {};
  const cells = ((await db.doc("weeks/" + mondayOf(date)).get()).data() || {}).cells || {};
  return (cfg.staff || []).filter((q) => q.uid && cells[date + "_" + q.id] === "L").map((q) => q.uid);
}

// Promemoria fissi. who: "shift" = chi è in turno, "admin" = solo amministratore.
const REM = [
  {key: "ap", at: 9 * 60 + 30, who: "shift", title: "Gestione", body: "Ricordati di fare apertura! ☀️", url: "?tab=ap", skip: "apConf"},
  {key: "apx", at: 10 * 60, who: "admin", title: "Apertura non confermata ⏰", body: "Alle 10:00 l’apertura non risulta ancora confermata.", url: "?tab=ap", skip: "apConf", needShift: true},
  {key: "mid", at: 15 * 60, who: "shift", title: "Gestione", body: "Controlla le tue attività giornaliere! ✌🏻", url: "?tab=oggi"},
  {key: "ch", at: 19 * 60 + 10, who: "shift", title: "Gestione", body: "Ricordati di fare chiusura! 🌙", url: "?tab=ch", skip: "chConf"},
  {key: "chx", at: 19 * 60 + 30, who: "admin", title: "Chiusura non confermata ⏰", body: "Alle 19:30 la chiusura non risulta ancora confermata.", url: "?tab=ch", skip: "chConf", needShift: true},
];

async function part(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.log("Errore in " + name + ":", (e && e.message) || e);
  }
}

async function run() {
  const {date, min} = romeNow();

  await part("notifiche in coda", async () => {
    const q = await db.collection("notif").get();
    for (const d of q.docs) {
      const n = d.data();
      try {
        const to = await resolveTo(n);
        if (to.length) await send(to, n.title, n.body, n.url);
      } catch (e) {
        console.log("Errore invio:", (e && e.message) || e);
      }
      await db.doc("notif/" + d.id).delete().catch(() => {});
    }
  });

  await part("promemoria giornalieri", async () => {
    const sentRef = db.doc("meta/notifsent");
    const sent = (await sentRef.get()).data() || {};
    const day = (await db.doc("days/" + date).get()).data() || {};
    for (const r of REM) {
      if (min < r.at || min >= r.at + 90 || sent[r.key] === date) continue;
      if (r.skip && day[r.skip]) {
        await sentRef.set({[r.key]: date}, {merge: true});
        continue;
      }
      const shift = await onShift(date);
      if (!shift.length && (r.who === "shift" || r.needShift)) continue;
      const to = r.who === "admin" ? [await adminUid()].filter(Boolean) : shift;
      await sentRef.set({[r.key]: date}, {merge: true});
      if (to.length) await send(to, r.title, r.body, r.url);
    }
  });

  console.log("Controllo completato.");
}

module.exports = {run, _test: {romeNow, mondayOf, addDays, short, setDb: (d) => { db = d; }, setNow: (f) => { nowFn = f; }, REM}};

if (require.main === module) {
  admin.initializeApp({credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))});
  db = admin.firestore();
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
