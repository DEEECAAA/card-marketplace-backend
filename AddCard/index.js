const { BlobServiceClient } = require("@azure/storage-blob");
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const { poolPromise } = require("../db");
const { v4: uuidv4 } = require("uuid");

const clientId = process.env.CLIENT_ID;
const blobStorageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.BLOB_CONTAINER_NAME;
const defaultImageUrl = process.env.DEFAULT_IMAGE_URL;

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

async function uploadImageToBlobStorage(base64Image) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(blobStorageConnectionString);
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobName = `card-images/${uuidv4()}.jpg`;
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

    if (authHeader) {
        const token = authHeader.split(" ")[1];
        try {
            const decoded = jwt.decode(token);
            if (decoded && validateIssuer(decoded.iss)) {
                userId = decoded.oid;
            }
        } catch (error) {
            console.error("Errore nella decodifica del token:", error.message);
        }
    }

    if (!userId) {
        context.res = {
            status: 401,
            body: { error: "Token JWT non valido o mancante" },
        };
        return;
    }

    try {
        let { name, description, price, quantity, image } = req.body;
        if (!name || !price || !quantity) {
            context.res = { status: 400, body: { error: "Tutti i campi (name, price, quantity) sono obbligatori" } };
            return;
        }

        description = description || "";
        let imageUrl = image ? await uploadImageToBlobStorage(image) : defaultImageUrl;

        const pool = await poolPromise;

        await pool.request()
            .input("OwnerId", userId)
            .input("Name", name)
            .input("Description", description)
            .input("Price", price)
            .input("Quantity", quantity)
            .input("ImageUrl", imageUrl)
            .query(`INSERT INTO Cards (OwnerId, Name, Description, Price, Quantity, ImageUrl) VALUES (@OwnerId, @Name, @Description, @Price, @Quantity, @ImageUrl)`);

        context.res = { status: 201, body: { message: "Carta aggiunta con successo!", imageUrl } };
    } catch (error) {
        context.res = { status: 500, body: { error: error.message } };
    }
};