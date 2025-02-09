const { BlobServiceClient } = require("@azure/storage-blob");
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const { poolPromise } = require("../db");

const clientId = process.env.CLIENT_ID;
const blobStorageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.BLOB_CONTAINER_NAME;

const client = jwksClient({
    jwksUri: `https://login.microsoftonline.com/common/discovery/v2.0/keys`
});

async function uploadImageToBlobStorage(base64Image) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(blobStorageConnectionString);
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobName = `deck-images/${Date.now()}.jpg`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    const buffer = Buffer.from(base64Image, "base64");

    await blockBlobClient.upload(buffer, buffer.length, {
        blobHTTPHeaders: { blobContentType: "image/jpeg" }
    });

    return blockBlobClient.url;
}

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
        if (decoded) {
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

    let { deckId, name, description, cards, image } = req.body;

    if (!deckId) {
        context.res = {
            status: 400,
            body: { error: "È necessario fornire l'ID del mazzo" },
        };
        return;
    }

    try {
        const pool = await poolPromise;

        const checkDeckQuery = `SELECT ImageUrl FROM Decks WHERE DeckId = @DeckId AND OwnerId = @UserId`;
        const checkDeckResult = await pool.request()
            .input("DeckId", deckId)
            .input("UserId", userId)
            .query(checkDeckQuery);

        if (checkDeckResult.recordset.length === 0) {
            context.res = {
                status: 403,
                body: { error: "Mazzo non trovato o non autorizzato a modificarlo." },
            };
            return;
        }

        let imageUrl = checkDeckResult.recordset[0].ImageUrl;
        if (image) {
            imageUrl = await uploadImageToBlobStorage(image);
        }

        await pool.request()
            .input("DeckId", deckId)
            .input("Name", name || null)
            .input("Description", description || null)
            .input("ImageUrl", imageUrl)
            .query(`
                UPDATE Decks
                SET 
                    Name = COALESCE(@Name, Name),
                    Description = COALESCE(@Description, Description),
                    ImageUrl = @ImageUrl
                WHERE DeckId = @DeckId
            `);

        const existingDeckCardsQuery = `SELECT CardId, Quantity FROM DeckCards WHERE DeckId = @DeckId`;
        const existingDeckCardsResult = await pool.request()
            .input("DeckId", deckId)
            .query(existingDeckCardsQuery);

        const existingDeckCards = existingDeckCardsResult.recordset;

        const newCardsMap = new Map(cards.map(card => [card.cardId, card.quantity]));
        const existingCardsMap = new Map(existingDeckCards.map(card => [card.CardId, card.Quantity]));

        for (const { CardId, Quantity } of existingDeckCards) {
            if (!newCardsMap.has(CardId)) {
                await pool.request()
                    .input("DeckId", deckId)
                    .input("CardId", CardId)
                    .query(`DELETE FROM DeckCards WHERE DeckId = @DeckId AND CardId = @CardId`);

                await pool.request()
                    .input("CardId", CardId)
                    .input("Quantity", Quantity)
                    .query(`UPDATE Cards SET Quantity = Quantity + @Quantity WHERE CardId = @CardId`);
            }
        }

        for (const card of cards) {
            const currentQuantity = existingCardsMap.get(card.cardId) || 0;
            const difference = card.quantity - currentQuantity;

            if (difference !== 0) {
                if (currentQuantity > 0) {
                    await pool.request()
                        .input("DeckId", deckId)
                        .input("CardId", card.cardId)
                        .input("Quantity", card.quantity)
                        .query(`UPDATE DeckCards SET Quantity = @Quantity WHERE DeckId = @DeckId AND CardId = @CardId`);
                } else {
                    await pool.request()
                        .input("DeckId", deckId)
                        .input("CardId", card.cardId)
                        .input("Quantity", card.quantity)
                        .query(`INSERT INTO DeckCards (DeckId, CardId, Quantity) VALUES (@DeckId, @CardId, @Quantity)`);
                }

                await pool.request()
                    .input("CardId", card.cardId)
                    .input("Quantity", difference * -1)
                    .query(`UPDATE Cards SET Quantity = Quantity + @Quantity WHERE CardId = @CardId`);
            }
        }

        await pool.request()
            .input("DeckId", deckId)
            .query(`
                UPDATE Decks
                SET TotalPrice = (
                    SELECT SUM(C.Price * DC.Quantity)
                    FROM DeckCards DC
                    INNER JOIN Cards C ON DC.CardId = C.CardId
                    WHERE DC.DeckId = @DeckId
                )
                WHERE DeckId = @DeckId
            `);

        context.res = {
            status: 200,
            body: { message: "Mazzo aggiornato con successo!", imageUrl },
        };
    } catch (error) {
        console.error("Errore durante l'aggiornamento del mazzo:", error.message);
        context.res = {
            status: 500,
            body: { error: `Errore del server: ${error.message}` },
        };
    }
};