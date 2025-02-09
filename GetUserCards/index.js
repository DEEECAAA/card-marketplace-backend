const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const { poolPromise } = require("../db");

const clientId = process.env.CLIENT_ID;

const client = jwksClient({
    jwksUri: `https://login.microsoftonline.com/common/discovery/v2.0/keys`
});

function getSigningKey(header, callback) {
    client.getSigningKey(header.kid, (err, key) => {
        if (err) {
            return callback(err);
        }
        const signingKey = key.publicKey || key.rsaPublicKey;
        callback(null, signingKey);
    });
}

const validateIssuer = (issuer) => {
    return issuer.startsWith("https://login.microsoftonline.com/") && issuer.endsWith("/v2.0");
};

module.exports = async function (context, req) {
    const authHeader = req.headers["authorization"];
    let userId = null;

    if (authHeader) {
        const token = authHeader.split(" ")[1];
        try {
            const decoded = jwt.decode(token);
            if (decoded && validateIssuer(decoded.iss)) {
                userId = decoded.oid;
            }
        } catch (error) {
            console.error("Errore nella decodifica del token:", error.message);
        }
    }

    if (!userId) {
        context.res = {
            status: 401,
            body: { error: "Token non valido o utente non autenticato." }
        };
        return;
    }

    try {
        const pool = await poolPromise;

        const query = `SELECT CardId, Name, Description, Price, Quantity, ImageUrl FROM Cards WHERE OwnerId = '${userId}' AND Quantity > 0`;
        
        const result = await pool.request().query(query);

        context.res = {
            status: 200,
            body: result.recordset
        };
    } catch (error) {
        console.error("Errore durante il recupero delle carte dell'utente:", error.message);
        context.res = {
            status: 500,
            body: { error: error.message }
        };
    }
};