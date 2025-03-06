const { poolPromise } = require("../db");
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const { BlobServiceClient } = require("@azure/storage-blob");

const client = jwksClient({
    jwksUri: `https://login.microsoftonline.com/common/discovery/v2.0/keys`
});

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME;

function getSigningKey(header, callback) {
    client.getSigningKey(header.kid, (err, key) => {
        if (err) {
            return callback(err);
        }
        const signingKey = key.publicKey || key.rsaPublicKey;
        callback(null, signingKey);
    });
}

async function deleteBlob(blobName) {
    try {
        const defaultImageName = "Pokemon-TCG-retro-carta.png";
        const folderPath = "card-images/";

        if (blobName === defaultImageName || blobName === `${folderPath}${defaultImageName}`) {
            return;
        }

        // Aggiungere il prefisso della cartella se non è già presente
        if (!blobName.startsWith(folderPath)) {
            blobName = `${folderPath}${blobName}`;
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
        const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
        const blobClient = containerClient.getBlobClient(blobName);

        const deleteResponse = await blobClient.deleteIfExists();

        const exists = await blobClient.exists();
    } catch (error) {
        console.error("❌ Errore durante l'eliminazione del file blob:", error.message);
    }
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
        if (decoded && validateIssuer(decoded.iss)) {
            userId = decoded.oid;
        }
    } catch (error) {
        console.error("❌ Errore nella decodifica del token:", error.message);
        context.res = {
            status: 401,
            body: { error: "Token JWT non valido" },
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
            const imageQuery = `SELECT ImageUrl FROM Cards WHERE CardId = @CardId`;
            const imageResult = await pool.request()
                .input("CardId", cardId)
                .query(imageQuery);

            if (imageResult.recordset.length > 0 && imageResult.recordset[0].ImageUrl) {
                const imageUrl = imageResult.recordset[0].ImageUrl;
                const blobName = imageUrl.split("/").pop(); // Estrai il nome del file
                await deleteBlob(blobName); // Elimina il file dal blob storage
            }

            const decksWithCardQuery = `
                SELECT DISTINCT DeckId FROM DeckCards WHERE CardId = @CardId
            `;
            const decksWithCardResult = await pool.request()
                .input("CardId", cardId)
                .query(decksWithCardQuery);

            const decksToDelete = decksWithCardResult.recordset.map(row => row.DeckId);

            if (decksToDelete.length > 0) {
                await pool.request()
                    .query(`DELETE FROM Decks WHERE DeckId IN (${decksToDelete.join(",")})`);
            }

            await pool.request()
                .input("CardId", cardId)
                .query(`DELETE FROM DeckCards WHERE CardId = @CardId`);

            await pool.request()
            .input("CardId", cardId)
            .query(`DELETE FROM Favorites WHERE CardId = @CardId`);

            await pool.request()
                .input("CardId", cardId)
                .query(`DELETE FROM Cards WHERE CardId = @CardId`);

            context.res = {
                status: 200,
                body: { message: `✅ Carta e ${decksToDelete.length} mazzi eliminati con successo!` },
            };
            return;
        }

        if (deckId) {
            const imageQuery = `SELECT ImageUrl FROM Decks WHERE DeckId = @DeckId`;
            const imageResult = await pool.request()
                .input("DeckId", deckId)
                .query(imageQuery);

            if (imageResult.recordset.length > 0 && imageResult.recordset[0].ImageUrl) {
                const imageUrl = imageResult.recordset[0].ImageUrl;
                const blobName = imageUrl.split("/").pop(); // Estrai il nome del file
                await deleteBlob(blobName); // Elimina il file dal blob storage
            }

            const checkDeckQuery = `SELECT DeckId FROM Decks WHERE DeckId = @DeckId AND OwnerId = @UserId`;
            const checkDeckResult = await pool.request()
                .input("DeckId", deckId)
                .input("UserId", userId)
                .query(checkDeckQuery);

            if (checkDeckResult.recordset.length === 0) {
                console.warn(`⛔ Mazzo non trovato o non autorizzato a rimuoverlo.`);
                context.res = {
                    status: 403,
                    body: { error: "Mazzo non trovato o non autorizzato a rimuoverlo." },
                };
                return;
            }

            const deckCardsQuery = `
                SELECT CardId, Quantity FROM DeckCards WHERE DeckId = @DeckId
            `;
            const deckCardsResult = await pool.request()
                .input("DeckId", deckId)
                .query(deckCardsQuery);

            if (deckCardsResult.recordset.length > 0) {
                for (const card of deckCardsResult.recordset) {
                    const { CardId, Quantity } = card;

                    await pool.request()
                        .input("CardId", CardId)
                        .input("Quantity", Quantity)
                        .query(`
                            UPDATE Cards SET Quantity = Quantity + @Quantity WHERE CardId = @CardId
                        `);
                }
            }

            await pool.request()
                .input("DeckId", deckId)
                .query(`DELETE FROM DeckCards WHERE DeckId = @DeckId`);

            await pool.request()
            .input("DeckId", deckId)
            .query(`DELETE FROM FavoritesDecks WHERE DeckId = @DeckId`);

            await pool.request()
                .input("DeckId", deckId)
                .query(`DELETE FROM Decks WHERE DeckId = @DeckId`);

            context.res = {
                status: 200,
                body: { message: "✅ Mazzo rimosso con successo e quantità delle carte ripristinate!" },
            };
            return;
        }
    } catch (error) {
        context.res = {
            status: 500,
            body: { error: `Errore del server: ${error.message}` },
        };
    }
};