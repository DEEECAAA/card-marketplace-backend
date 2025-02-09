const { poolPromise } = require("../db");
const { BlobServiceClient } = require("@azure/storage-blob");
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");

const client = jwksClient({
    jwksUri: `https://login.microsoftonline.com/common/discovery/v2.0/keys`
});

const defaultImageUrl = process.env.DEFAULT_IMAGE_URL;

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
            context.log("Errore nella decodifica del token:", error.message);
        }
    }

    if (!userId) {
        context.res = {
            status: 401,
            body: { error: "Token JWT non valido o mancante" },
        };
        return;
    }

    try {
        let { name, description, imageUrl, cards } = req.body;
        if (!name || !cards || !Array.isArray(cards) || cards.length === 0) {
            context.res = {
                status: 400,
                body: { error: "Il nome del mazzo e una lista di carte valide sono obbligatori" },
            };
            return;
        }

        description = description || "";
        imageUrl = imageUrl || defaultImageUrl;

        const pool = await poolPromise;
        const result = await pool.request()
            .input("Name", name)
            .input("Description", description)
            .input("OwnerId", userId)
            .input("ImageUrl", imageUrl)
            .input("TotalPrice", 0)
            .query("INSERT INTO Decks (Name, Description, OwnerId, ImageUrl, TotalPrice) OUTPUT INSERTED.DeckId VALUES (@Name, @Description, @OwnerId, @ImageUrl, @TotalPrice)");
        
        const deckId = result.recordset[0].DeckId;
        let totalPrice = 0;

        for (const card of cards) {
            const { cardId, quantity } = card;
            if (!cardId || !quantity || quantity < 1) {
                continue;
            }

            const cardResult = await pool.request()
                .input("CardId", cardId)
                .query("SELECT Quantity, Price FROM Cards WHERE CardId = @CardId");

            if (cardResult.recordset.length > 0) {
                const { Quantity, Price } = cardResult.recordset[0];
                
                if (quantity > Quantity) {
                    context.res = {
                        status: 400,
                        body: { error: `La quantità selezionata per la carta ID ${cardId} supera la disponibilità.` },
                    };
                    return;
                }

                totalPrice += Price * quantity;

                const newQuantity = Quantity - quantity;

                await pool.request()
                    .input("CardId", cardId)
                    .input("Quantity", newQuantity > 0 ? newQuantity : 0)
                    .query("UPDATE Cards SET Quantity = @Quantity WHERE CardId = @CardId");

                if (newQuantity <= 0) {
                    await pool.request()
                        .input("CardId", cardId)
                        .query("DELETE FROM Favorites WHERE CardId = @CardId");
                }

                await pool.request()
                    .input("DeckId", deckId)
                    .input("CardId", cardId)
                    .input("Quantity", quantity)
                    .query("INSERT INTO DeckCards (DeckId, CardId, Quantity) VALUES (@DeckId, @CardId, @Quantity)");
            }
        }

        await pool.request()
            .input("DeckId", deckId)
            .input("TotalPrice", totalPrice)
            .query("UPDATE Decks SET TotalPrice = @TotalPrice WHERE DeckId = @DeckId");
        
        context.res = {
            status: 201,
            body: { message: "Mazzo creato con successo!", deckId },
        };
    } catch (err) {
        context.log("Errore del server:", err.message);
        context.res = {
            status: 500,
            body: { error: `Errore del server: ${err.message}` },
        };
    }
};