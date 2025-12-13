const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// --- INIT ---
// Ensure these are in your .env
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-prod';
const IS_PROD = process.env.NODE_ENV === 'production';

// --- MIDDLEWARE ---
// 1. Enable Cookie Parsing for this router
router.use(cookieParser());

// 2. Auth Guard (Middleware to protect routes)
const authenticateAdmin = (req, res, next) => {
    const token = req.cookies.admin_token; // Read from HttpOnly Cookie

    if (!token) {
        return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // Attach user to request
        next();
    } catch (err) {
        return res.status(401).json({ error: "INVALID_TOKEN" });
    }
};


// --- AUTH ROUTES ---

// 1️⃣ LOGIN (Issue Cookie)
router.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "MISSING_CREDENTIALS" });
        }

        // A. Database Lookup
        // Assumes table 'university_admins' exists
        const { data: admin, error } = await supabase
            .from('university_admins')
            .select('admin_id, admin_name, email, university_id, password')
            .eq('email', email)
            .single();

        // B. Password Check (Plain text as requested)
        if (error || !admin || admin.password !== password) {
            return res.status(401).json({ error: "INVALID_CREDENTIALS" });
        }

        // C. Generate JWT
        const token = jwt.sign(
            {
                sub: admin.email,
                name: admin.admin_name,
                universityId: admin.university_id,
                id: admin.admin_id
            },
            JWT_SECRET,
            { expiresIn: '2h' }
        );

        // D. Set HttpOnly Cookie
        res.cookie('admin_token', token, {
            httpOnly: true,
            secure: IS_PROD,           // True in Prod (HTTPS), False in Dev (HTTP)
            sameSite: IS_PROD ? 'None' : 'Lax', // None for Cross-Site (Prod), Lax for Local
            maxAge: 2 * 60 * 60 * 1000 // 2 Hours
        });

        res.json({ success: true, message: "Logged in successfully" });

    } catch (e) {
        console.error("Login Error:", e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});

// 2️⃣ ME (Session Check)
router.get('/auth/me', authenticateAdmin, (req, res) => {
    // If we get here, the middleware already validated the token
    res.json({
        email: req.user.sub,
        name: req.user.name,
        universityId: req.user.universityId,
        isAuthenticated: true
    });
});

// 3️⃣ LOGOUT (Clear Cookie)
router.post('/auth/logout', (req, res) => {
    res.cookie('admin_token', '', {
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        expires: new Date(0) // Expire immediately
    });
    res.json({ success: true, message: "Logged out" });
});


// --- PROTECTED ROUTES EXAMPLE ---
// Uses the same `authenticateAdmin` middleware
router.get('/admin/my-batches', authenticateAdmin, async (req, res) => {
    try {
        const { data } = await supabase
            .from('batches')
            .select('*')
            .eq('university_id', req.user.universityId); // Use ID from Token!

        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
