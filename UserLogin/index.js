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
            console.error("Errore nel recupero della chiave di firma:", err);
            return callback(err);
        }
        const signingKey = key.publicKey || key.rsaPublicKey;
        callback(null, signingKey);
    });
}

const validateIssuer = (issuer) => {
    if (issuer.startsWith("https://login.microsoftonline.com/") && issuer.endsWith("/v2.0")) {
        return true;
    }
    console.log(`Issuer non valido ricevuto: ${issuer}`);
    return false;
};

module.exports = async function (context, req) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        console.error("Token mancante");
        context.res = { status: 401, body: { error: "Token mancante" } };
        return;
    }

    const token = authHeader.split(" ")[1];

    jwt.verify(token, getSigningKey, { algorithms: ["RS256"], audience: clientId }, async (err, decoded) => {
        if (err) {
            console.error("Errore di autenticazione:", err);
            context.res = { status: 401, body: { error: `Token non valido: ${err.message}` } };
            return;
        }

        const { iss, aud, oid, name, email, preferred_username, given_name, family_name } = decoded;

        if (aud !== clientId) {
            console.error(`Audience non valida. Atteso: ${clientId}, ricevuto: ${aud}`);
            context.res = { status: 401, body: { error: "Token JWT non valido: audience non valida" } };
            return;
        }

        if (!validateIssuer(iss)) {
            console.error(`Issuer non valido: ricevuto ${iss}`);
            context.res = { status: 401, body: { error: `Token JWT non valido: issuer non valido (${iss})` } };
            return;
        }

        try {
            const pool = await poolPromise;
            
            const finalUsername = preferred_username || email || "Unknown";
            const finalName = name || `${given_name} ${family_name}` || "Unknown";

            const userCheck = await pool.request()
                .input("UserId", oid)
                .input("Email", email || "no-email@example.com")
                .input("Username", finalUsername)
                .query("SELECT * FROM Users WHERE UserId = @UserId OR Email = @Email OR Username = @Username");

            if (!userCheck.recordset.length) {

                await pool.request()
                    .input("UserId", oid)
                    .input("Username", finalUsername)
                    .input("Email", email || "no-email@example.com")
                    .input("Name", finalName)
                    .query("INSERT INTO Users (UserId, Username, Email, Name) VALUES (@UserId, @Username, @Email, @Name)");

            }
            context.res = { status: 200, body: { message: "Autenticazione riuscita", user: decoded } };
        } catch (dbError) {
            console.error("Errore di database:", dbError);
            context.res = { status: 500, body: { error: "Errore interno del server" } };
        }
    });
};