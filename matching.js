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
 * Finds the vehicle matching a plate number (from BillRefNumber).
 * Returns the vehicle doc snapshot, or null if no match.
 */
async function findVehicleByPlate(rawPlate) {
    const normalized = normalizePlate(rawPlate);
    if (!normalized) return null;

    // We can't query Firestore on a normalized field unless it's stored that way,
    // so we store a `plateNormalized` field on vehicle docs (see backfill note below)
    // and query directly against it.
    const snapshot = await db.collection('matatus')
        .where('plateNormalized', '==', normalized)
        .limit(1)
        .get();

    if (snapshot.empty) return null;
    return snapshot.docs[0];
}

/**
 * Finds the active assignment for a vehicle (links it to its current driver).
 * Assumes assignments have a `status` field, with 'active' marking the current one.
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
        assignmentId: assignmentDoc.id,
        amount: parseFloat(payment.TransAmount),
        source: 'mpesa',
        mpesaPaymentId: paymentId,
        mpesaTransactionId: payment.TransID,
        date: payment.TransTime,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { matched: true, collectionId: collectionRef.id };
}

module.exports = { matchAndCreateCollection, normalizePlate, findVehicleByPlate };