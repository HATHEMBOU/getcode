require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// --- Configuration ---
const MINIMUM_PRICE_CENTS = 100; // Minimum price in cents (e.g., $1.00 USD)
const TOKEN_EXPIRATION_MS = 5 * 60 * 1000; // 5 minutes for download link validity

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}

// --- Temporary store for active download tokens ---
// In a production app, this should be a more persistent store (e.g., Redis, DB)
// Format: { token: { projectId, expiresAt: Date.now() + TOKEN_EXPIRATION_MS } }
const activeDownloadTokens = {};

// --- Helper function to read/write DB ---
function readDB() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            fs.writeFileSync(DB_PATH, '[]', 'utf-8'); // Create if not exists
        }
        const data = fs.readFileSync(DB_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error("Error reading DB:", error);
        return []; // Return empty array if file doesn't exist or is corrupted
    }
}

function writeDB(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
        console.error("Error writing DB:", error);
    }
}

// --- Multer Setup for File Uploads ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOADS_DIR);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed') {
            cb(null, true);
        } else {
            cb(new Error('Only .zip files are allowed!'), false);
        }
    },
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// --- Middleware ---
app.use(express.json()); // For parsing application/json in request bodies
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from 'public'

// --- EJS Setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // Ensure you have a 'views' folder

// --- Routes ---

// API: GET /api/projects - Get all projects data
app.get('/api/projects', (req, res) => {
    const projects = readDB();
    res.json(projects);
});

// POST /upload - Handle new project submission
app.post('/upload', upload.single('sourceCodeZip'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded or invalid file type.');
    }

    const { developerName, websiteUrl } = req.body;
    if (!developerName || !websiteUrl) {
        // You might want to send a more user-friendly response or redirect with an error
        return res.status(400).send('Developer name and website URL are required.');
    }

    const projects = readDB();
    const newProject = {
        id: uuidv4(),
        developerName,
        websiteUrl,
        zipFileName: req.file.filename,
        originalZipName: req.file.originalname,
        uploadedAt: new Date().toISOString(),
    };
    projects.push(newProject);
    writeDB(projects);

    console.log('Project uploaded:', newProject);
    res.redirect('/?uploaded=true');
});

// POST /create-checkout-session/:projectId - Stripe payment initiation
app.post('/create-checkout-session/:projectId', async (req, res) => {
    const { projectId } = req.params;
    const { amount } = req.body; // Get amount from request body (sent as number from frontend)

    // --- Backend Validation for Amount ---
    if (typeof amount !== 'number' || isNaN(amount)) {
        return res.status(400).json({ error: 'Invalid amount provided. Must be a number.' });
    }

    const amountInCents = Math.round(amount * 100); // Convert to cents

    if (amountInCents < MINIMUM_PRICE_CENTS) {
        return res.status(400).json({ error: `Invalid amount. Minimum price is $${(MINIMUM_PRICE_CENTS / 100).toFixed(2)}.` });
    }
    if (amountInCents > 99999999) { // Stripe's max limit for unit_amount (e.g., $999,999.99)
        return res.status(400).json({ error: 'Amount is too large.' });
    }

    const projects = readDB();
    const project = projects.find(p => p.id === projectId);

    if (!project) {
        return res.status(404).json({ error: 'Project not found.' });
    }

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd', // Or your desired currency e.g. process.env.CURRENCY || 'usd'
                        product_data: {
                            name: `Source Code: ${project.originalZipName.replace(/\.zip$/i, '')}`,
                            description: `Developer: ${project.developerName}. URL: ${project.websiteUrl}`,
                        },
                        unit_amount: amountInCents, // Price in cents
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: `${process.env.BASE_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}&project_id=${project.id}`,
            cancel_url: `${process.env.BASE_URL}/cancel.html?project_id=${project.id}`,
            metadata: { // Pass project ID and amount to webhook or success page
                projectId: project.id,
                amountPaidCents: amountInCents
            }
        });
        res.json({ id: session.id });
    } catch (error) {
        console.error('Stripe session creation error:', error);
        res.status(500).json({ error: 'Could not create payment session. Please try again.' });
    }
});

// GET /payment-success - Handle successful payment redirect
app.get('/payment-success', async (req, res) => {
    const { session_id, project_id } = req.query;

    if (!session_id || !project_id) {
        return res.status(400).send('Missing session ID or project ID.');
    }

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);

        // Verify payment status (important!)
        if (session.payment_status === 'paid') {
            // Also verify that the projectId from the session metadata matches query param
            // This adds an extra layer of security, ensuring the session_id is for this specific project purchase
            if (session.metadata && session.metadata.projectId !== project_id) {
                console.warn(`Potential tampering: session_id ${session_id} metadata project_id ${session.metadata.projectId} does not match query project_id ${project_id}`);
                return res.status(403).send('Payment verification failed. Mismatched project.');
            }

            const projects = readDB();
            const project = projects.find(p => p.id === project_id);

            if (!project) {
                return res.status(404).send('Project not found after payment.');
            }

            // Generate a unique download token
            const downloadToken = uuidv4();
            activeDownloadTokens[downloadToken] = {
                projectId: project.id,
                expiresAt: Date.now() + TOKEN_EXPIRATION_MS
            };

            // Simple cleanup for expired tokens (can be improved for production)
            Object.keys(activeDownloadTokens).forEach(token => {
                if (activeDownloadTokens[token].expiresAt < Date.now()) {
                    delete activeDownloadTokens[token];
                }
            });

            console.log(`Payment successful for project ${project_id} (Session: ${session_id}). Token: ${downloadToken}. Amount: ${(session.metadata.amountPaidCents / 100).toFixed(2) || 'N/A'}`);
            res.render('success', {
                projectName: project.originalZipName,
                downloadLink: `/download/${project.id}/${downloadToken}`
            });
        } else {
            console.log(`Payment status for session ${session_id} is ${session.payment_status} (not 'paid').`);
            res.redirect(`/cancel.html?reason=payment_not_confirmed&project_id=${project_id}`);
        }
    } catch (error) {
        console.error('Error retrieving Stripe session or processing payment success:', error);
        res.status(500).send('Error processing payment confirmation.');
    }
});

// GET /download/:projectId/:token - Securely serve the ZIP file
app.get('/download/:projectId/:token', (req, res) => {
    const { projectId, token } = req.params;

    const tokenData = activeDownloadTokens[token];

    if (!tokenData || tokenData.projectId !== projectId || tokenData.expiresAt < Date.now()) {
        delete activeDownloadTokens[token]; // Remove invalid or expired token if found
        console.warn(`Download attempt failed for project ${projectId} with token ${token}. Reason: Invalid, mismatched, or expired.`);
        return res.status(403).send('Invalid or expired download link. This link may have already been used or has expired. Please try purchasing again or contact support.');
    }

    // Token is valid, find the project
    const projects = readDB();
    const project = projects.find(p => p.id === projectId);

    if (!project) {
        console.error(`Project with ID ${projectId} not found for download, even though token was valid.`);
        return res.status(404).send('Project file information not found.');
    }

    const filePath = path.join(UPLOADS_DIR, project.zipFileName);
    if (fs.existsSync(filePath)) {
        // Invalidate the token after successful retrieval to make it a one-time download
        delete activeDownloadTokens[token];
        console.log(`Download initiated for ${project.originalZipName}. Token ${token} used and invalidated.`);

        res.download(filePath, project.originalZipName, (err) => {
            if (err) {
                console.error("Error sending file:", err);
                // Check if headers were already sent before trying to send another response
                if (!res.headersSent) {
                    res.status(500).send('Could not download the file due to a server error.');
                }
            }
        });
    } else {
        console.error(`File not found on server: ${filePath} for project ${projectId}`);
        // This case should ideally not happen if upload was successful
        res.status(404).send('The source code file is missing on the server. Please contact support.');
    }
});


// --- Error Handling Middleware (optional but good practice) ---
// This should be the last `app.use`
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err.stack || err);
    // Specific error handling for multer (e.g., file too large)
    if (err instanceof multer.MulterError) {
        return res.status(400).send(`File upload error: ${err.message}. Check file size or type.`);
    } else if (err.message === 'Only .zip files are allowed!') { // Custom error from fileFilter
         return res.status(400).send(err.message);
    }
    // Generic error
    if (!res.headersSent) {
        res.status(500).send('Something broke on the server!');
    }
});


// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server running on ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
    console.log(`Stripe Keys: ${process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY ? 'OK' : 'MISSING! Check .env file'}`);
    console.log(`Minimum price for items: $${(MINIMUM_PRICE_CENTS / 100).toFixed(2)}`);
    if (!process.env.BASE_URL) {
        console.warn("WARN: BASE_URL not set in .env. Using default. This might cause issues with Stripe redirects.");
    }
});