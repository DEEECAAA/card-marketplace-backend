const sql = require("mssql");
const { poolPromise } = require("../db");

module.exports = async function (context, req) {
    context.log("Richiesta ricevuta per ottenere le carte di un mazzo...");

    const { deckId } = req.query;

    if (!deckId) {
        context.res = {
            status: 400,
            body: { error: "È necessario fornire un ID mazzo." },
        };
        return;
    }

    try {
        const pool = await poolPromise;

        const query = `
            SELECT c.CardId, c.Name, c.Description, c.Price, dc.Quantity, c.ImageUrl
            FROM DeckCards dc
            INNER JOIN Cards c ON dc.CardId = c.CardId
            WHERE dc.DeckId = @DeckId
        `;

        const result = await pool.request()
            .input("DeckId", sql.Int, deckId)
            .query(query);

        if (result.recordset.length === 0) {
            context.res = {
                status: 404,
                body: { message: "Nessuna carta trovata per questo mazzo." },
            };
            return;
        }

        context.res = {
            status: 200,
            body: result.recordset,
        };
    } catch (error) {
        context.log("Errore durante il recupero delle carte del mazzo:", error.message);
        context.res = {
            status: 500,
            body: { error: `Errore del server: ${error.message}` },
        };
    }
};