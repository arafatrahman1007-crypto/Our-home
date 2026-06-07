const express  = require('express');
const cors     = require('cors');
const webpush  = require('web-push');
const admin    = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ─── VAPID keys (set these as Railway environment variables) ───────────────
// Generate once with:  node -e "const wp=require('web-push'); console.log(wp.generateVAPIDKeys())"
// Then paste into Railway → Variables
webpush.setVapidDetails(
  'mailto:' + process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ─── Firebase Admin (set FIREBASE_SERVICE_ACCOUNT in Railway variables) ────
// Value = the entire service account JSON as a single string
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
  databaseURL: 'https://our-home-58c42-default-rtdb.europe-west1.firebasedatabase.app'
});

const db = admin.database();

// ─── Health check ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'our-place-ping' }));

// ─── Save a push subscription ─────────────────────────────────────────────
// Called by the browser after it gets a PushSubscription object
// Body: { userId: 'player1' | 'player2', subscription: { endpoint, keys } }
app.post('/subscribe', async (req, res) => {
  const { userId, subscription } = req.body;
  if (!userId || !subscription?.endpoint) {
    return res.status(400).json({ error: 'Missing userId or subscription' });
  }
  try {
    await db.ref('push_subscriptions/' + userId).set({
      subscription,
      updatedAt: Date.now()
    });
    console.log('Subscription saved for', userId);
    res.json({ ok: true });
  } catch (e) {
    console.error('Subscribe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Send a ping ──────────────────────────────────────────────────────────
// Called by the page when the user taps the ping button
// Body: { fromId: 'player1', toId: 'player2', fromName: 'Sofia' }
app.post('/ping', async (req, res) => {
  const { fromId, toId, fromName } = req.body;
  if (!fromId || !toId) {
    return res.status(400).json({ error: 'Missing fromId or toId' });
  }

  try {
    // 1. Write ping to Firebase so the open tab gets the visual ripple too
    await db.ref('pings').push({
      from: fromId,
      to:   toId,
      name: fromName || 'Someone special',
      ts:   Date.now()
    });

    // 2. Look up recipient's push subscription
    const snap = await db.ref('push_subscriptions/' + toId).once('value');
    const data = snap.val();

    if (!data?.subscription) {
      // Recipient hasn't granted permission yet — visual ping still works
      return res.json({ ok: true, pushed: false, reason: 'no_subscription' });
    }

    // 3. Send the real Web Push notification
    const payload = JSON.stringify({
      title: '💗 ' + (fromName || 'Someone') + ' is thinking of you',
      body:  'Open your place to feel the love ♥',
      icon:  '/icon-192.png',
      badge: '/icon-192.png',
      tag:   'our-place-ping',       // replaces previous ping notification
      renotify: true,
      data:  { url: '/' }
    });

    await webpush.sendNotification(data.subscription, payload);
    console.log('Push sent to', toId, 'from', fromId);
    res.json({ ok: true, pushed: true });

  } catch (e) {
    // 410 = subscription expired/invalid — clean it up
    if (e.statusCode === 410) {
      await db.ref('push_subscriptions/' + toId).remove();
      console.log('Removed stale subscription for', toId);
      return res.json({ ok: true, pushed: false, reason: 'stale_subscription' });
    }
    console.error('Ping error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Ping server running on port', PORT));
