const { db } = require('./firestoreClient');
const admin = require('firebase-admin');

/**
 * Normalizes a plate number for comparison.
 * Conductors will type plates inconsistently (spaces, lowercase, dashes),
 * so we strip everything except alphanumerics and uppercase it.
 * "KDA 123A", "kda-123a", "kda123a" all normalize to "KDA123A".
 */
function normalizePlate(raw) {
    if (!raw) return '';
    return raw.toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Converts Safaricom TransTime string "YYYYMMDDHHmmss" to epoch milliseconds.
 * This ensures `date` is always a Long in Firestore, matching app-written records
 * and allowing Firestore orderBy queries to work without mixed-type issues.
 */
function parseTransTime(transTime) {
    if (!transTime) return Date.now();
    const s = transTime.toString();
    return new Date(
        `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` +
        `T${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}`
    ).getTime();
}

/**
 * Finds the vehicle matching a plate number (from BillRefNumber).
 * Queries the `matatus` collection (matches Android app collection name).
 */
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

/**
 * Finds the active assignment for a vehicle.
 * Status is stored as 'ACTIVE' (uppercase) by the Android app.
 */
async function findActiveAssignment(vehicleId) {
    const snapshot = await db.collection('assignments')
        .where('vehicleId', '==', vehicleId)
        .where('status', '==', 'ACTIVE')
        .limit(1)
        .get();

    if (snapshot.empty) return null;
    return snapshot.docs[0];
}

/**
 * Attempts to match an incoming M-Pesa payment to a vehicle + driver,
 * and if successful, writes a denormalized collection record.
 *
 * Returns { matched: boolean, collectionId?: string, reason?: string }
 */
async function matchAndCreateCollection(paymentId, payment) {
    const vehicleDoc = await findVehicleByPlate(payment.BillRefNumber);
    if (!vehicleDoc) {
        return { matched: false, reason: 'no_vehicle_for_plate' };
    }

    const vehicle = vehicleDoc.data();
    const assignmentDoc = await findActiveAssignment(vehicleDoc.id);

    if (!assignmentDoc) {
        return { matched: false, reason: 'no_active_assignment' };
    }

    const assignment = assignmentDoc.data();
    const driverDoc = await db.collection('drivers').doc(assignment.driverId).get();

    if (!driverDoc.exists) {
        return { matched: false, reason: 'driver_not_found' };
    }

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
        date: parseTransTime(payment.TransTime),   // always epoch ms — no mixed types
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { matched: true, collectionId: collectionRef.id };
}

module.exports = { matchAndCreateCollection, normalizePlate, findVehicleByPlate };