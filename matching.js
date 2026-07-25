const { db } = require('./firestoreClient');
const admin = require('firebase-admin');

/**
 * Normalizes a plate number for comparison.
 * Strips everything except alphanumerics and uppercases.
 * "KBS 567L", "kbs-567l", "kbs567l" all → "KBS567L"
 */
function normalizePlate(raw) {
    if (!raw) return '';
    return raw.toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Converts Safaricom TransTime "YYYYMMDDHHmmss" to epoch ms.
 * Uses Africa/Nairobi offset (+03:00) since Safaricom timestamps are EAT.
 */
function parseTransTime(transTime) {
    if (!transTime) return Date.now();
    const s = transTime.toString();
    return new Date(
        `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` +
        `T${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}+03:00`
    ).getTime();
}

/**
 * Finds the matatu matching a plate number from BillRefNumber.
 * Queries on plateNormalized so spacing/casing differences don't matter.
 */
async function findVehicleByPlate(rawPlate) {
    const normalized = normalizePlate(rawPlate);
    if (!normalized) return null;

    console.log(`Looking up plate: "${rawPlate}" → normalized: "${normalized}"`);

    const snapshot = await db.collection('matatus')
        .where('plateNormalized', '==', normalized)
        .limit(1)
        .get();

    if (snapshot.empty) {
        console.log(`No vehicle found for normalized plate "${normalized}"`);
        return null;
    }

    console.log(`Found vehicle: ${snapshot.docs[0].id}`);
    return snapshot.docs[0];
}

/**
 * Finds the active assignment for a vehicle.
 */
async function findActiveAssignment(vehicleId) {
    const snapshot = await db.collection('assignments')
        .where('vehicleId', '==', vehicleId)
        .where('status', '==', 'ACTIVE')
        .limit(1)
        .get();

    if (snapshot.empty) {
        console.log(`No active assignment for vehicle ${vehicleId}`);
        return null;
    }

    return snapshot.docs[0];
}

/**
 * Matches an incoming M-Pesa payment to a vehicle + driver and writes
 * a collection record. Returns { matched, collectionId?, reason? }.
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

    // driverName: prefer denormalized field on assignment, fall back to driver lookup
    let driverName = assignment.driverName || '';
    if (!driverName && assignment.driverId) {
        const driverDoc = await db.collection('drivers').doc(assignment.driverId).get();
        if (!driverDoc.exists) {
            return { matched: false, reason: 'driver_not_found' };
        }
        driverName = driverDoc.data().name || '';
    }

    // plateNumber: prefer vehicle doc (authoritative), fall back to assignment
    const plateNumber = vehicle.plateNumber
        || assignment.plateNumber
        || payment.BillRefNumber;

    const collectionRef = db.collection('collections').doc();
    await collectionRef.set({
        driverId:           assignment.driverId   || '',
        driverName:         driverName,
        vehicleId:          vehicleDoc.id,
        vehiclePlate:       plateNumber,
        plateNumber:        plateNumber,
        assignmentId:       assignmentDoc.id,
        amount:             Number(payment.TransAmount),
        source:             'mpesa',
        mpesaPaymentId:     paymentId,
        mpesaTransactionId: payment.TransID,
        date:               parseTransTime(payment.TransTime),
        createdAt:          admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Collection created: ${collectionRef.id} for ${plateNumber} — KES ${payment.TransAmount}`);
    return { matched: true, collectionId: collectionRef.id };
}

module.exports = { matchAndCreateCollection, normalizePlate, findVehicleByPlate };