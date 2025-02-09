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
    const blobName = `card-images/${Date.now()}.jpg`;
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

    let { cardId, name, description, price, quantity, image } = req.body;

    if (!cardId) {
        context.res = {
            status: 400,
            body: { error: "È necessario fornire l'ID della carta" },
        };
        return;
    }

    try {
        const pool = await poolPromise;

        const currentCardQuery = `SELECT Quantity, ImageUrl FROM Cards WHERE CardId = @CardId AND OwnerId = @UserId`;
        const currentCardResult = await pool.request()
            .input("CardId", cardId)
            .input("UserId", userId)
            .query(currentCardQuery);

        if (currentCardResult.recordset.length === 0) {
            context.res = {
                status: 403,
                body: { error: "Carta non trovata o non autorizzato a modificarla." },
            };
            return;
        }

        let imageUrl = currentCardResult.recordset[0].ImageUrl;

        if (image) {
            imageUrl = await uploadImageToBlobStorage(image);
        }

        await pool.request()
            .input("CardId", cardId)
            .input("Name", name || null)
            .input("Description", description || null)
            .input("Price", price || null)
            .input("Quantity", quantity || null)
            .input("ImageUrl", imageUrl)
            .query(`
                UPDATE Cards
                SET 
                    Name = COALESCE(@Name, Name),
                    Description = COALESCE(@Description, Description),
                    Price = COALESCE(@Price, Price),
                    Quantity = COALESCE(@Quantity, Quantity),
                    ImageUrl = @ImageUrl
                WHERE CardId = @CardId
            `);

        const updateDecksQuery = `SELECT DISTINCT DeckId FROM DeckCards WHERE CardId = @CardId`;
        const decksToUpdateResult = await pool.request()
            .input("CardId", cardId)
            .query(updateDecksQuery);

        const decksToUpdate = decksToUpdateResult.recordset.map(row => row.DeckId);

        if (decksToUpdate.length > 0) {
            for (const deckId of decksToUpdate) {
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
            }
        }

        context.res = {
            status: 200,
            body: { 
                message: `Carta aggiornata con successo. ${decksToUpdate.length} mazzi aggiornati.`,
                imageUrl 
            },
        };
    } catch (error) {
        console.error("Errore durante l'aggiornamento della carta:", error.message);
        context.res = {
            status: 500,
            body: { error: `Errore del server: ${error.message}` },
        };
    }
};