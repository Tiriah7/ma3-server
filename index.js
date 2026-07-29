require('dotenv').config();
const express = require('express');
const { db, saveMpesaPayment } = require('./firestore');
const { admin } = require('./firestoreClient');
const { registerC2BUrls } = require('./mpesa');
const { matchAndCreateCollection } = require('./matching');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Webhook secret middleware ──────────────────────────────────────────────────
// All /mpesa/* routes require ?secret=WEBHOOK_SECRET in the URL.
// Safaricom appends query params when registering URLs so this works seamlessly.
function requireWebhookSecret(req, res, next) {
    const provided = req.query.secret;
    const expected = process.env.WEBHOOK_SECRET;

    if (!expected) {
        console.error('WEBHOOK_SECRET env variable is not set. Blocking request.');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    if (!provided || provided !== expected) {
        console.warn(`Rejected webhook — invalid secret. IP: ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'Ma3 Sacco server running' });
});

// ── M-Pesa endpoints (secret-protected) ──────────────────────────────────────
app.post('/mpesa/validation', requireWebhookSecret, (req, res) => {
    console.log('Validation request:', req.body);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.post('/mpesa/confirmation', requireWebhookSecret, async (req, res) => {
    console.log('Payment received:', req.body);
    try {
        await saveMpesaPayment(req.body);
    } catch (error) {
        console.error('Unexpected error processing payment:', error);
    }
    // Always return success — telling Safaricom it failed triggers endless retries
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ── Admin endpoints ───────────────────────────────────────────────────────────
app.get('/admin/unmatched-payments', async (req, res) => {
    try {
        const snapshot = await db.collection('mpesa_payments')
            .where('matched', '==', false)
            .orderBy('receivedAt', 'desc')
            .limit(50)
            .get();

        const payments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json({ count: payments.length, payments });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/admin/payments/:transId/rematch', async (req, res) => {
    try {
        const paymentRef = db.collection('mpesa_payments').doc(req.params.transId);
        const paymentDoc = await paymentRef.get();

        if (!paymentDoc.exists) {
            return res.status(404).json({ error: 'Payment not found' });
        }

        const payment = paymentDoc.data();
        const result = await matchAndCreateCollection(req.params.transId, {
            TransID: req.params.transId,
            TransAmount: payment.amount,
            BillRefNumber: req.body.billRefNumber || payment.billRefNumber,
            TransTime: payment.transactionDate
        });

        if (result.matched) {
            await paymentRef.update({
                matched: true,
                collectionId: result.collectionId,
                matchFailureReason: admin.firestore.FieldValue.delete()
            });
        }

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/admin/register-urls', async (req, res) => {
    try {
        const serverUrl = req.body.serverUrl;
        const secret = process.env.WEBHOOK_SECRET;

        if (!secret) {
            return res.status(500).json({ error: 'WEBHOOK_SECRET not configured' });
        }

        // Secret is appended to the URLs so Safaricom sends it back on every call
        const result = await registerC2BUrls(serverUrl, secret);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});