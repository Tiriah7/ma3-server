const { db, admin } = require('./firestoreClient');
const { matchAndCreateCollection } = require('./matching');

/**
 * Saves the raw M-Pesa confirmation, then attempts to match it to a
 * vehicle/driver and create a collection record. The raw payment is
 * always kept in `mpesa_payments` as the source of truth / audit trail,
 * regardless of whether matching succeeds.
 */
async function saveMpesaPayment(payment) {
    const paymentRef = db.collection('mpesa_payments').doc(payment.TransID);

    await paymentRef.set({
        transactionId: payment.TransID,
        transactionType: payment.TransactionType,
        amount: parseFloat(payment.TransAmount),
        msisdn: payment.MSISDN,
        firstName: payment.FirstName || '',
        billRefNumber: payment.BillRefNumber || '',
        shortCode: payment.BusinessShortCode,
        transactionDate: payment.TransTime,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        matched: false
    });

    console.log(`Saved payment ${payment.TransID} — KES ${payment.TransAmount}`);

    let matchResult;
    try {
        matchResult = await matchAndCreateCollection(payment.TransID, payment);
    } catch (error) {
        // Matching failure should never break the confirmation flow —
        // the payment is already safely saved and can be matched manually later.
        console.error(`Matching failed for ${payment.TransID}:`, error);
        matchResult = { matched: false, reason: 'matching_error' };
    }

    if (matchResult.matched) {
        await paymentRef.update({
            matched: true,
            collectionId: matchResult.collectionId
        });
        console.log(`Matched payment ${payment.TransID} → collection ${matchResult.collectionId}`);
    } else {
        await paymentRef.update({
            matched: false,
            matchFailureReason: matchResult.reason || 'unknown'
        });
        console.log(`Could not auto-match payment ${payment.TransID}: ${matchResult.reason}`);
    }

    return matchResult;
}

module.exports = { db, saveMpesaPayment };