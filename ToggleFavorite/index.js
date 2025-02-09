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
            body: { error: "Autenticazione richiesta" },
        };
        return;
    }

    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.decode(token);
        if (decoded && validateIssuer(decoded.iss) && decoded.oid) {
            userId = decoded.oid;
        } else {
            throw new Error("ID utente non trovato nel token.");
        }
    } catch (error) {
        context.log("Errore nella decodifica del token:", error.message);
        context.res = {
            status: 401,
            body: { error: "Token JWT non valido o utente non trovato." },
        };
        return;
    }

    if (!userId) {
        context.res = {
            status: 401,
            body: { error: "Autenticazione non valida. ID utente mancante nel token." },
        };
        return;
    }

    const { cardId, deckId } = req.body;
    if (!cardId && !deckId) {
        context.res = {
            status: 400,
            body: { error: "È necessario fornire un ID carta o un ID mazzo." },
        };
        return;
    }

    try {
        const pool = await poolPromise;

        if (cardId) {
            const checkCardQuery = `SELECT FavoriteId FROM Favorites WHERE UserId = @UserId AND CardId = @CardId`;
            const checkCardResult = await pool.request()
                .input("UserId", userId)
                .input("CardId", cardId)
                .query(checkCardQuery);

            if (checkCardResult.recordset.length > 0) {
                await pool.request()
                    .input("UserId", userId)
                    .input("CardId", cardId)
                    .query(`DELETE FROM Favorites WHERE UserId = @UserId AND CardId = @CardId`);
                
                context.res = {
                    status: 200,
                    body: { message: "Carta rimossa dai preferiti con successo!" },
                };
            } else {
                await pool.request()
                    .input("UserId", userId)
                    .input("CardId", cardId)
                    .query(`INSERT INTO Favorites (UserId, CardId, CreatedAt) VALUES (@UserId, @CardId, GETDATE())`);
                
                context.res = {
                    status: 201,
                    body: { message: "Carta aggiunta ai preferiti con successo!" },
                };
            }
        }

        if (deckId) {
            const checkDeckQuery = `SELECT FavoriteId FROM FavoritesDecks WHERE UserId = @UserId AND DeckId = @DeckId`;
            const checkDeckResult = await pool.request()
                .input("UserId", userId)
                .input("DeckId", deckId)
                .query(checkDeckQuery);

            if (checkDeckResult.recordset.length > 0) {
                await pool.request()
                    .input("UserId", userId)
                    .input("DeckId", deckId)
                    .query(`DELETE FROM FavoritesDecks WHERE UserId = @UserId AND DeckId = @DeckId`);
                
                context.res = {
                    status: 200,
                    body: { message: "Mazzo rimosso dai preferiti con successo!" },
                };
            } else {
                await pool.request()
                    .input("UserId", userId)
                    .input("DeckId", deckId)
                    .query(`INSERT INTO FavoritesDecks (UserId, DeckId, CreatedAt) VALUES (@UserId, @DeckId, GETDATE())`);
                
                context.res = {
                    status: 201,
                    body: { message: "Mazzo aggiunto ai preferiti con successo!" },
                };
            }
        }
    } catch (error) {
        context.log("Errore durante la gestione dei preferiti:", error.message);
        context.res = {
            status: 500,
            body: { error: `Errore del server: ${error.message}` },
        };
    }
};