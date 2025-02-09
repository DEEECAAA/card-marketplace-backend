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
    const { cardId } = req.query;
    console.log("Parametri ricevuti:", req.query);
    if (!cardId) {
        context.res = {
            status: 400,
            body: { error: "CardId è richiesto" }
        };
        return;
    }

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

    try {
        const pool = await poolPromise;

        let query = `
            SELECT CardId, Name, Description, Price, Quantity, ImageUrl, OwnerId
            FROM Cards
            WHERE CardId = @cardId
        `;

        const request = pool.request();
        request.input("cardId", cardId);
        
        const result = await request.query(query);

        if (result.recordset.length === 0) {
            context.res = {
                status: 404,
                body: { error: "Carta non trovata" }
            };
            return;
        }

        const card = result.recordset[0];

        context.res = {
            status: 200,
            body: card
        };
    } catch (error) {
        console.error("Errore durante il recupero della carta:", error.message);
        context.res = {
            status: 500,
            body: { error: error.message }
        };
    }
};