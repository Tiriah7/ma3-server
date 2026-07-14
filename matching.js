const { db } = require('./firestoreClient');
const admin = require('firebase-admin');

function normalizePlate(raw) {
    if (!raw) return '';
    return raw.toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Converts Safaricom TransTime "YYYYMMDDHHmmss" to epoch ms.
 * Falls back to Date.now() — Safaricom confirmations arrive within seconds
 * of the real payment, so anything more than 1 hour old is test/stale data.
 */
function parseTransTime(transTime) {
    if (!transTime) return Date.now();
    const s = transTime.toString();
    const parsed = new Date(
        `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` +
        `T${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}`
    ).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return parsed >= oneHourAgo ? parsed : Date.now();
}

async function findVehicleByPlate(rawPlate) {
    const normalized = normalizePlate(rawPlate);
    if (!normalized) return null;
    const snapshot = await db.collection('matatus')
        .where('plateNormalized', '==', normalized)
        .limit(1)
        .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0];
}

async function findActiveAssignment(vehicleId) {
    const snapshot = await db.collection('assignments')
        .where('vehicleId', '==', vehicleId)
        .where('status', '==', 'ACTIVE')
        .limit(1)
        .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0];
}

async function matchAndCreateCollection(paymentId, payment) {
    const vehicleDoc = await findVehicleByPlate(payment.BillRefNumber);
    if (!vehicleDoc) return { matched: false, reason: 'no_vehicle_for_plate' };

    const vehicle = vehicleDoc.data();
    const assignmentDoc = await findActiveAssignment(vehicleDoc.id);
    if (!assignmentDoc) return { matched: false, reason: 'no_active_assignment' };

    const assignment = assignmentDoc.data();
    const driverDoc = await db.collection('drivers').doc(assignment.driverId).get();
    if (!driverDoc.exists) return { matched: false, reason: 'driver_not_found' };

    const driver = driverDoc.data();

    const collectionRef = db.collection('collections').doc();
    await collectionRef.set({
        driverId: assignment.driverId,
        driverName: driver.name,
        vehicleId: vehicleDoc.id,
        vehiclePlate: vehicle.plateNumber,
        plateNumber: vehicle.plateNumber,
        assignmentId: assignmentDoc.id,
        amount: parseFloat(payment.TransAmount),
        source: 'mpesa',
        mpesaPaymentId: paymentId,
        mpesaTransactionId: payment.TransID,
        date: parseTransTime(payment.TransTime),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { matched: true, collectionId: collectionRef.id };
}

module.exports = { matchAndCreateCollection, normalizePlate, findVehicleByPlate };