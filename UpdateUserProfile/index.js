const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const { poolPromise } = require("../db");

const client = jwksClient({
    jwksUri: `https://login.microsoftonline.com/common/discovery/v2.0/keys`
});

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

    let { username } = req.body;

    if (!username || username.trim() === "") {
        context.res = {
            status: 400,
            body: { error: "Il nome utente non può essere vuoto" },
        };
        return;
    }

    try {
        const pool = await poolPromise;

        const checkUserQuery = `SELECT UserId FROM Users WHERE Username = @Username`;
        const checkUserResult = await pool.request()
            .input("Username", username)
            .query(checkUserQuery);

        if (checkUserResult.recordset.length > 0) {
            context.res = {
                status: 400,
                body: { error: "Questo nome utente è già in uso, scegline un altro." },
            };
            return;
        }

        await pool.request()
            .input("UserId", userId)
            .input("Username", username)
            .query(`
                UPDATE Users
                SET Username = @Username
                WHERE UserId = @UserId
            `);

        context.res = {
            status: 200,
            body: { message: "Profilo aggiornato con successo!", username },
        };
    } catch (error) {
        console.error("Errore durante l'aggiornamento del profilo:", error.message);
        context.res = {
            status: 500,
            body: { error: `Errore del server: ${error.message}` },
        };
    }
};