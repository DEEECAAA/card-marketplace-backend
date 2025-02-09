const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const { poolPromise } = require("../db");

const clientId = process.env.CLIENT_ID;

const client = jwksClient({
    jwksUri: `https://login.microsoftonline.com/common/discovery/v2.0/keys`
});

module.exports = async function (context, req) {
    const authHeader = req.headers["authorization"];
    let userId = null;

    if (authHeader) {
        const token = authHeader.split(" ")[1];
        try {
            const decoded = jwt.decode(token);
            if (decoded) {
                userId = decoded.oid;
            }
        } catch (error) {
            console.error("Errore nella decodifica del token:", error.message);
        }
    }

    if (!userId) {
        context.res = {
            status: 401,
            body: { error: "Autenticazione necessaria" }
        };
        return;
    }

    try {
        const pool = await poolPromise;
        
        const userResult = await pool
            .request()
            .input("UserId", userId)
            .query("SELECT UserId, Username, Email, Name, CreatedAt FROM Users WHERE UserId = @UserId");

        if (!userResult.recordset.length) {
            console.error("Utente non trovato");
            context.res = { status: 404, body: { error: "Utente non trovato" } };
            return;
        }

        const user = userResult.recordset[0];

        const cardsResult = await pool
            .request()
            .input("OwnerId", user.UserId)
            .query("SELECT CardId, Name, Description, Price, ImageUrl, Quantity FROM Cards WHERE OwnerId = @OwnerId");

        const decksResult = await pool
        .request()
        .input("OwnerId", user.UserId)
        .query("SELECT DeckId, Name, Description, TotalPrice, ImageUrl FROM Decks WHERE OwnerId = @OwnerId");

        context.res = {
            status: 200,
            body: {
                user: {
                    UserId: user.UserId,
                    Username: user.Username,
                    Email: user.Email,
                    Name: user.Name,
                    CreatedAt: user.CreatedAt
                },
                cards: cardsResult.recordset.map(card => ({
                    CardId: card.CardId,
                    Name: card.Name,
                    Description: card.Description,
                    Price: card.Price,
                    ImageUrl: card.ImageUrl,
                    Quantity: card.Quantity
                })),
                decks: decksResult.recordset.map(deck => ({
                    DeckId: deck.DeckId,
                    Name: deck.Name,
                    Description: deck.Description,
                    TotalPrice: deck.TotalPrice,
                    ImageUrl: deck.ImageUrl
                }))
            }
        };
    } catch (error) {
        console.error("Errore durante il recupero del profilo utente:", error.message);
        context.res = {
            status: 500,
            body: { error: error.message }
        };
    }
};