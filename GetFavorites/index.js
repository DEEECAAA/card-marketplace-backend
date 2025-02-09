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

    if (!authHeader) {
        context.res = {
            status: 401,
            body: { error: "Autenticazione richiesta per visualizzare i preferiti." },
        };
        return;
    }

    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.decode(token);
        if (decoded && validateIssuer(decoded.iss)) {
            userId = decoded.oid;
        }
    } catch (error) {
        console.error("Errore nella decodifica del token:", error.message);
        context.res = {
            status: 401,
            body: { error: "Token JWT non valido" },
        };
        return;
    }

    try {
        const pool = await poolPromise;

        const cardQuery = `
            SELECT C.CardId, C.Name, C.Description, C.Price, C.Quantity, C.ImageUrl 
            FROM Favorites F
            INNER JOIN Cards C ON F.CardId = C.CardId
            WHERE F.UserId = @UserId
        `;

        const deckQuery = `
            SELECT D.DeckId, D.Name, D.Description, D.TotalPrice, D.CreatedAt, D.ImageUrl 
            FROM FavoritesDecks FD
            INNER JOIN Decks D ON FD.DeckId = D.DeckId
            WHERE FD.UserId = @UserId
        `;

        const cardResult = await pool.request().input("UserId", userId).query(cardQuery);
        const deckResult = await pool.request().input("UserId", userId).query(deckQuery);

        context.res = {
            status: 200,
            body: {
                favoriteCards: cardResult.recordset,
                favoriteDecks: deckResult.recordset,
            },
        };
    } catch (error) {
        console.error("Errore durante il recupero dei preferiti:", error.message);
        context.res = {
            status: 500,
            body: { error: error.message },
        };
    }
};