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

    try {
        const pool = await poolPromise;

        const transactionsQuery = `
            SELECT TransactionId, Amount AS TotalAmount, TransactionDate 
            FROM Transactions 
            WHERE BuyerId = @UserId
            ORDER BY TransactionDate DESC
        `;
        const transactionsResult = await pool.request()
            .input("UserId", userId)
            .query(transactionsQuery);

        if (transactionsResult.recordset.length === 0) {
            context.res = {
                status: 200,
                body: { transactions: [] }
            };
            return;
        }

        const transactions = transactionsResult.recordset;

        for (let transaction of transactions) {
            const detailsQuery = `
                SELECT td.TransactionId, 
                    ch.Name AS CardName, 
                    ch.Price AS CardPrice, 
                    td.Quantity AS CardQuantity, 
                    dh.Name AS DeckName, 
                    dh.Price AS DeckPrice
                FROM TransactionDetails td
                LEFT JOIN CardsHistory ch ON td.CardId = ch.CardId
                LEFT JOIN DecksHistory dh ON td.DeckId = dh.DeckId
                WHERE td.TransactionId = @TransactionId
            `;

            const detailsResult = await pool.request()
                .input("TransactionId", transaction.TransactionId)
                .query(detailsQuery);

            transaction.details = detailsResult.recordset;
        }

        context.res = {
            status: 200,
            body: { transactions }
        };
    } catch (error) {
        console.error("Errore durante il recupero delle transazioni:", error.message);
        context.res = {
            status: 500,
            body: { error: `Errore del server: ${error.message}` },
        };
    }
};