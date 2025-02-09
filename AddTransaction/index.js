const { poolPromise } = require("../db");
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");

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

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        context.res = {
            status: 401,
            body: { error: "Autenticazione richiesta. Token non presente o non valido." },
        };
        return;
    }

    const token = authHeader.split(" ")[1];

    try {
        const decoded = jwt.decode(token);
        if (decoded && validateIssuer(decoded.iss)) {
            userId = decoded.oid || decoded.sub;
        }

        if (!userId) {
            throw new Error("Impossibile ottenere BuyerId dal token.");
        }
    } catch (error) {
        context.res = {
            status: 401,
            body: { error: "Token JWT non valido o userId non trovato." },
        };
        return;
    }

    const { items, totalAmount } = req.body;

    if (!items || items.length === 0 || !totalAmount) {
        context.res = {
            status: 400,
            body: { error: "Dati non validi: elenco di carte/deck mancante o totale importo nullo." },
        };
        return;
    }

    let transaction;

    try {
        const pool = await poolPromise;
        transaction = pool.transaction();
        await transaction.begin();

        const transactionResult = await transaction.request()
            .input("BuyerId", userId)
            .input("Amount", totalAmount)
            .query(`
                INSERT INTO Transactions (BuyerId, Amount, TransactionDate)
                OUTPUT INSERTED.TransactionId
                VALUES (@BuyerId, @Amount, GETDATE())
            `);

        const transactionId = transactionResult.recordset[0]?.TransactionId;
        if (!transactionId) throw new Error("Errore nella creazione della transazione");

        for (const item of items) {
            if (item.cardId) {
                const cardResult = await transaction.request()
                    .input("CardId", item.cardId)
                    .query(`SELECT Name, Description, Quantity, Price FROM Cards WHERE CardId = @CardId`);

                if (cardResult.recordset.length > 0) {
                    const { Name, Description, Quantity, Price } = cardResult.recordset[0];
                    const newQuantity = Math.max(Quantity - item.quantity, 0);

                    await transaction.request()
                        .input("CardId", item.cardId)
                        .input("Name", Name)
                        .input("Description", Description)
                        .input("Price", Price)
                        .input("QuantitySold", item.quantity)
                        .query(`
                            INSERT INTO CardsHistory (CardId, Name, Description, Price, QuantitySold, SoldDate)
                            VALUES (@CardId, @Name, @Description, @Price, @QuantitySold, GETDATE())
                        `);

                    await transaction.request()
                    .input("TransactionId", transactionId)
                    .input("CardId", item.cardId)
                    .input("Quantity", item.quantity)
                    .input("Price", item.price)
                    .query(`
                        INSERT INTO TransactionDetails (TransactionId, CardId, Quantity, Price)
                        VALUES (@TransactionId, @CardId, @Quantity, @Price)
                    `);
                    if (newQuantity === 0) {
                        const deckCheck = await transaction.request()
                            .input("CardId", item.cardId)
                            .query(`SELECT COUNT(*) AS Count FROM DeckCards WHERE CardId = @CardId`);
                    
                        const isInDeck = deckCheck.recordset[0]?.Count > 0;
                    
                        if (isInDeck) {
                            await transaction.request()
                                .input("CardId", item.cardId)
                                .input("Quantity", newQuantity)
                                .query(`UPDATE Cards SET Quantity = @Quantity WHERE CardId = @CardId`);
                        } else {
                            await transaction.request()
                                .input("CardId", item.cardId)
                                .query(`DELETE FROM Favorites WHERE CardId = @CardId`);

                            await transaction.request()
                                .input("CardId", item.cardId)
                                .query(`DELETE FROM Cards WHERE CardId = @CardId`);
                        }
                    } else {
                        await transaction.request()
                            .input("CardId", item.cardId)
                            .input("Quantity", newQuantity)
                            .query(`UPDATE Cards SET Quantity = @Quantity WHERE CardId = @CardId`);
                    }
                }
            } else if (item.deckId) {
                await transaction.request()
                    .input("DeckId", item.deckId)
                    .query(`
                        INSERT INTO DecksHistory (DeckId, Name, Description, Price, SoldDate)
                        SELECT DeckId, Name, Description, TotalPrice, GETDATE() FROM Decks WHERE DeckId = @DeckId
                    `);

                await transaction.request()
                    .input("TransactionId", transactionId)
                    .input("DeckId", item.deckId)
                    .input("Price", item.price)
                    .query(`
                        INSERT INTO TransactionDetails (TransactionId, DeckId, Quantity, Price)
                        VALUES (@TransactionId, @DeckId, 1, @Price)
                    `);

                await transaction.request()
                .input("DeckId", item.deckId)
                .query(`DELETE FROM DeckCards WHERE DeckId = @DeckId`);

                await transaction.request()
                .input("DeckId", item.deckId)
                .query(`DELETE FROM FavoritesDecks WHERE DeckId = @DeckId`);

                await transaction.request()
                .input("DeckId", item.deckId)
                .query(`DELETE FROM Decks WHERE DeckId = @DeckId`);
            }
        }

        await transaction.commit();

        context.res = {
            status: 201,
            body: { message: "Transazione registrata con successo!" },
        };
    } catch (error) {
        console.error("Errore durante la registrazione della transazione:", error.message);

        if (transaction) await transaction.rollback();

        context.res = {
            status: 500,
            body: { error: `Errore del server: ${error.message}` },
        };
    }
};