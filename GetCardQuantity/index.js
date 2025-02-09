const sql = require("mssql");
const { poolPromise } = require("../db");

module.exports = async function (context, req) {
    context.log("Richiesta ricevuta per ottenere la quantità delle carte...");

    const { cardIds } = req.body;

    if (!cardIds || !Array.isArray(cardIds) || cardIds.length === 0) {
        context.res = {
            status: 400,
            body: { error: "Devi fornire un array di ID carte valido." },
        };
        return;
    }

    try {
        const pool = await poolPromise;

        const query = `
            SELECT CardId, Quantity 
            FROM Cards 
            WHERE CardId IN (${cardIds.map((_, i) => `@CardId${i}`).join(", ")})
        `;

        const request = pool.request();
        cardIds.forEach((id, i) => request.input(`CardId${i}`, sql.Int, id));

        const result = await request.query(query);

        if (result.recordset.length === 0) {
            context.res = {
                status: 404,
                body: { message: "Nessuna carta trovata per gli ID forniti." },
            };
            return;
        }

        const quantities = {};
        result.recordset.forEach((row) => {
            quantities[row.CardId] = row.Quantity;
        });

        context.res = {
            status: 200,
            body: quantities,
        };
    } catch (error) {
        context.log("Errore durante il recupero delle quantità delle carte:", error.message);
        context.res = {
            status: 500,
            body: { error: `Errore del server: ${error.message}` },
        };
    }
};