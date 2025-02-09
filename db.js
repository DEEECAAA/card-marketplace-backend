require("dotenv").config();
const sql = require("mssql");

const config = {
  server: process.env.DB_SERVER,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  options: {
    encrypt: true,
    enableArithAbort: true,
  },
};

const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then((pool) => {
    return pool;
  })
  .catch((err) => {
    console.error("Errore di connessione al database:", err);
    throw err;
  });

module.exports = {
  sql,
  poolPromise,
};