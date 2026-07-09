const admin = require('firebase-admin');

// Download your Firebase service account key from:
// Firebase Console → Project Settings → Service Accounts → Generate New Private Key
// Save it as serviceAccountKey.json in the project root.
// NEVER commit this file — it's in .gitignore.
const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

module.exports = { admin, db };