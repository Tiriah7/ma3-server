const axios = require('axios');

const BASE_URL = process.env.MPESA_ENVIRONMENT === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

async function getAccessToken() {
    const credentials = Buffer.from(
        `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const response = await axios.get(
        `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${credentials}` } }
    );
    return response.data.access_token;
}

async function registerC2BUrls(serverUrl, secret) {
    const token = await getAccessToken();

    // Append secret as query param — Safaricom will include it on every callback
    const confirmationURL = `${serverUrl}/mpesa/confirmation?secret=${secret}`;
    const validationURL   = `${serverUrl}/mpesa/validation?secret=${secret}`;

    const response = await axios.post(
        `${BASE_URL}/mpesa/c2b/v1/registerurl`,
        {
            ShortCode:       process.env.MPESA_SHORTCODE,
            ResponseType:    'Completed',
            ConfirmationURL: confirmationURL,
            ValidationURL:   validationURL,
        },
        {
            headers: {
                Authorization:  `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        }
    );

    console.log('C2B URLs registered:');
    console.log('  Confirmation:', confirmationURL);
    console.log('  Validation:  ', validationURL);
    console.log('  Response:    ', response.data);
    return response.data;
}

module.exports = { getAccessToken, registerC2BUrls };