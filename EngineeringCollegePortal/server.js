const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const sqlite3 = require("sqlite3").verbose();
const fetch = require("node-fetch"); 

const app = express();
const PORT = 5000;

// --- Define allowed table names for security ---
const KCET_ROUNDS = {
    "I": "Round1", 
    "II": "Round2"  
};

// COMEDK now always points to the single 'comedk' table
const COMEDK_ROUNDS = {
    "I": "comedk" 
};

// ================= Database Connection and Setup =================
const db = new sqlite3.Database(
    path.join(__dirname, "database", "colleges.db"),
    (err) => {
        if (err) console.error("DB Error:", err.message);
        else {
            console.log("✅ Connected to SQLite database.");
            
            // --- USERS TABLE CREATION (For Login/Signup) ---
            db.run(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT UNIQUE NOT NULL,
                    password TEXT NOT NULL,
                    role TEXT NOT NULL,
                    exam TEXT,   
                    rank INTEGER  
                )
            `, (err) => {
                if (err) console.error("Table Creation Error:", err.message);
                else console.log("✅ Users table ensured.");
            });
        }
    }
);

// ================= Middleware and Setup =================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ================= reCAPTCHA Keys (UPDATED) =================
const RECAPTCHA_SITE_KEY = "6LcX4OIrAAAAAM0djWEoKC00ydVlvnhHqsH-pVGO";
const RECAPTCHA_SECRET_KEY = "6LcX4OIrAAAAAGLlwZYIw9M4sbvD3qLitcNOkbEk";

// ================= Routes =================

// Serve login/signup page (auth.html or login.html)
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html")); 
});

// -------- Signup Route (Functional Logic) --------
app.post("/signup", async (req, res) => {
    const { email, password, role, exam, rank, "g-recaptcha-response": token } = req.body; 
    
    const finalExam = exam || null;
    const finalRank = parseInt(rank) || null;

    if (!token) return res.status(400).json({ error: "Captcha not completed" });

    try {
        // --- FIX: Ensure data is sent to Google in URL-encoded format ---
        const captchaRes = await fetch("https://www.google.com/recaptcha/api/siteverify", { 
            method: "POST", 
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `secret=${RECAPTCHA_SECRET_KEY}&response=${token}`,
        });
        const captchaData = await captchaRes.json();
        
        if (!captchaData.success) {
            console.error("reCAPTCHA Verification Failed:", captchaData);
            return res.status(400).json({ error: "Captcha verification failed" });
        }
        // ------------------------------------------------------------------

        // Check for existing user
        db.get("SELECT email FROM users WHERE email = ?", [email], (err, row) => {
            if (err) return res.status(500).json({ error: "Database error during lookup" });
            if (row) return res.status(409).json({ error: "Email already registered." });

            // Insert new user into DB 
            db.run(
                "INSERT INTO users (email, password, role, exam, rank) VALUES (?, ?, ?, ?, ?)",
                [email, password, role, finalExam, finalRank],
                function (err) {
                    if (err) { 
                        console.error("Database Insert Error:", err.message); 
                        return res.status(500).json({ error: "Database insertion failed" });
                    }
                    console.log(`✅ New user inserted with ID: ${this.lastID}`);
                    res.json({ message: "Signup successful!" });
                }
            );
        });
    } catch (err) {
        console.error("Signup verification error:", err);
        res.status(500).json({ error: "Server error during captcha verification" });
    }
});


// -------- Login Route (EDITED FOR CONDITIONAL REDIRECTION) --------
app.post("/login", async (req, res) => {
    const { email, password, exam, "g-recaptcha-response": token } = req.body; 
    if (!token) return res.status(400).json({ error: "Captcha not completed" });

    try {
        // --- FIX: Ensure data is sent to Google in URL-encoded format ---
        const captchaRes = await fetch("https://www.google.com/recaptcha/api/siteverify", { 
            method: "POST", 
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `secret=${RECAPTCHA_SECRET_KEY}&response=${token}`,
        });
        const captchaData = await captchaRes.json();
        
        if (!captchaData.success) {
             console.error("reCAPTCHA Verification Failed:", captchaData);
            return res.status(400).json({ error: "Captcha verification failed" });
        }
        // ------------------------------------------------------------------

        db.get("SELECT * FROM users WHERE email = ? AND password = ?", [email, password], (err, row) => {
            if (err) return res.status(500).json({ error: "Database error" });
            if (!row) return res.status(401).json({ error: "Invalid credentials" });
            
            // --- CONDITIONAL REDIRECT LOGIC ---
            let redirectUrl = "/rank.html"; // Default (KCET/generic)
            
            const lowerExam = exam.toLowerCase();

            if (lowerExam === 'kcet') {
                redirectUrl = "/rank.html"; 
            } else if (lowerExam === 'comedk') {
                redirectUrl = "/rank1.html"; 
            } else if (lowerExam === 'private_exam') {
                redirectUrl = "/private.html"; // NEW REDIRECT
            }
            
            // Successful login
            res.json({ message: "Login successful!", user: row, redirect: redirectUrl });
        });
    } catch (err) {
        console.error("Login verification error:", err);
        res.status(500).json({ error: "Server error during captcha verification" });
    }
});

// -------- Get Colleges Route (Dynamic Lookup Logic) --------
app.post("/getColleges", (req, res) => {
    const { rank, round, exam } = req.body; 
    
    if (!rank || !round || !exam) return res.status(400).send("Rank, round, and exam type are required");

    const examType = exam.toUpperCase();
    
    let roundMap, cutoffColumns, orderByClause;

    // --- Branch Logic based on Exam Type ---
    if (examType === 'KCET') {
        roundMap = KCET_ROUNDS;
        cutoffColumns = ['"1g"', '"2a"', 'scr']; 
        
        // FIX: Sort by the LOWEST (best) cutoff rank using COALESCE.
        // This ensures the most competitive and relevant colleges for a strong rank appear first.
        orderByClause = 'ORDER BY COALESCE("1g", "2a", scr, 999999) ASC';

    } else if (examType === 'COMEDK') {
        roundMap = COMEDK_ROUNDS; 
        cutoffColumns = ['gm', 'kkr']; 
        
        // Prioritize sorting by the lowest COMEDK cutoff
        orderByClause = 'ORDER BY gm ASC'; 
        
    } else {
        return res.status(400).json({ error: "Unsupported exam type." });
    }
    // ----------------------------------------
    
    // Validate and get table name
    const tableName = roundMap[round];
    if (!tableName) {
        return res.status(400).json({ error: `Invalid counseling round selected for ${examType}.` });
    }
    
    // Construct the WHERE clause dynamically based on the available cutoffs
    // Logic: Your Rank (?) <= College Cutoff Rank (col)
    const whereClauses = cutoffColumns.map(col => `? <= ${col}`).join(' OR ');

    // SQL: Final Query Construction
    const query = `
        SELECT "college name", branch, ${cutoffColumns.join(', ')}
        FROM ${tableName}
        WHERE ${whereClauses}
        ${orderByClause}
    `;

    // The placeholders in WHERE are all the user's rank
    const params = Array(cutoffColumns.length).fill(rank);

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error(`Database lookup error for ${tableName}:`, err.message);
            return res.status(500).json({ error: `Database lookup failed for ${examType}. Check table '${tableName}' in colleges.db` });
        }

        // Return data as JSON for the frontend to render dynamically
        res.json({ colleges: rows, exam: examType }); 
    });
});

// ================= Start Server =================
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});