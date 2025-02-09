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
    const { deckId } = req.query;
    if (!deckId) {
        context.res = {
            status: 400,
            body: { error: "DeckId è richiesto" }
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

        let deckQuery = `
            SELECT DeckId, Name, Description, TotalPrice, ImageUrl, OwnerId
            FROM Decks
            WHERE DeckId = @deckId
        `;

        const request = pool.request();
        request.input("deckId", deckId);

        const deckResult = await request.query(deckQuery);

        if (deckResult.recordset.length === 0) {
            context.res = {
                status: 404,
                body: { error: "Deck non trovato" }
            };
            return;
        }

        let deck = deckResult.recordset[0];

        let cardsQuery = `
            SELECT c.CardId, c.Name, c.Description, c.Price, dc.Quantity, c.ImageUrl
            FROM DeckCards dc
            INNER JOIN Cards c ON dc.CardId = c.CardId
            WHERE dc.DeckId = @deckId
        `;

        const cardsResult = await request.query(cardsQuery);

        deck.cards = cardsResult.recordset;

        context.res = {
            status: 200,
            body: deck
        };
    } catch (error) {
        console.error("Errore durante il recupero del deck:", error.message);
        context.res = {
            status: 500,
            body: { error: error.message }
        };
    }
};