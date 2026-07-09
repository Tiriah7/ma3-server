require('dotenv').config();
const express = require('express');
const { db, saveMpesaPayment } = require('./firestore');
const { admin } = require('./firestoreClient');
const { registerC2BUrls } = require('./mpesa');
const { matchAndCreateCollection } = require('./matching');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check — Railway uses this to confirm the server is running
app.get('/', (req, res) => {
    res.json({ status: 'Ma3 Sacco server running' });
});

// Safaricom calls this to validate a payment before processing
app.post('/mpesa/validation', (req, res) => {
    console.log('Validation request:', req.body);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Safaricom calls this when a payment is confirmed.
// Saving + matching happens inside saveMpesaPayment; this handler just
// guarantees Safaricom always gets a success response so they don't retry.
app.post('/mpesa/confirmation', async (req, res) => {
    console.log('Payment received:', req.body);
    try {
        await saveMpesaPayment(req.body);
    } catch (error) {
        // Even if something unexpected blows up, the payment write is the
        // critical path — log loudly so it surfaces, but never tell
        // Safaricom it failed (that triggers endless retries).
        console.error('Unexpected error processing payment:', error);
    }
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// List unmatched payments — for a field manager screen / manual matching UI
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

// Manually re-attempt matching a payment (e.g. after fixing a vehicle's
// plate number, or after the field manager corrects the BillRefNumber
// on the payment doc directly in Firestore)
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
            await paymentRef.update({ matched: true, collectionId: result.collectionId, matchFailureReason: admin.firestore.FieldValue.delete() });
        }

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Manually trigger C2B URL registration (call once after deployment)
app.post('/admin/register-urls', async (req, res) => {
    try {
        const serverUrl = req.body.serverUrl; // e.g. https://your-app.railway.app
        const result = await registerC2BUrls(serverUrl);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});